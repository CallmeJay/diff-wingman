import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import type { CodexStatus } from '../shared/types.js';
import { AppError } from './errors.js';

const exec = promisify(execFile);

// 显式移除 API 覆盖，防止本应使用订阅的导读意外触发按量付费。
function codexEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  ])
    delete env[name];
  return env;
}

export async function getCodexStatus(): Promise<CodexStatus> {
  try {
    const version = await exec('codex', ['--version'], {
      env: codexEnvironment(),
      timeout: 10_000,
    });
    const auth = await exec('codex', ['login', 'status'], {
      env: codexEnvironment(),
      timeout: 10_000,
    });
    const subscription = /Logged in using ChatGPT/i.test(auth.stdout + auth.stderr);
    return {
      available: true,
      subscription,
      version: version.stdout.trim(),
      message: subscription
        ? '已使用 ChatGPT 登录'
        : '当前不是 ChatGPT 登录；请在终端运行 codex login。',
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      available: !missing,
      subscription: false,
      version: '',
      message: missing
        ? '未找到 Codex CLI，请安装后刷新。'
        : '无法确认 Codex 登录状态，请在终端运行 codex login status。',
    };
  }
}

export interface GenerateOptions {
  prompt: string;
  schema: ZodTypeAny;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

export interface GuideProvider {
  generate(options: GenerateOptions): Promise<unknown>;
}

export class CodexProvider implements GuideProvider {
  async generate({ prompt, schema, signal, onProgress }: GenerateOptions): Promise<unknown> {
    const status = await getCodexStatus();
    if (!status.subscription) throw new AppError(409, status.message);
    signal.throwIfAborted();
    const directory = await mkdtemp(path.join(tmpdir(), 'diff-wingman-'));
    const schemaPath = path.join(directory, 'schema.json');
    const outputPath = path.join(directory, 'result.json');
    try {
      await writeFile(
        schemaPath,
        JSON.stringify(zodToJsonSchema(schema, { $refStrategy: 'none' })),
        { mode: 0o600 },
      );
      onProgress('已连接 Codex，正在分析固定版本的源码上下文…');
      await new Promise<void>((resolve, reject) => {
        // 在空临时目录启动，避免被审查仓库的规则、配置或 hooks 被当作指令执行。
        const disabled = [
          'shell_tool',
          'unified_exec',
          'apps',
          'plugins',
          'hooks',
          'multi_agent',
          'memories',
          'browser_use',
          'computer_use',
          'in_app_browser',
          'image_generation',
          'goals',
        ];
        const child = spawn(
          'codex',
          [
            'exec',
            '--ignore-user-config',
            ...disabled.flatMap((feature) => ['--disable', feature]),
            '-c',
            'web_search="disabled"',
            '--sandbox',
            'read-only',
            '--skip-git-repo-check',
            '--ephemeral',
            '--json',
            '--color',
            'never',
            '--output-schema',
            schemaPath,
            '--output-last-message',
            outputPath,
            '-',
          ],
          {
            cwd: directory,
            shell: false,
            env: codexEnvironment(),
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          },
        );
        let stderr = '';
        let failure = '';
        let bytes = 0;
        let timedOut = false;
        let forceKill: ReturnType<typeof setTimeout> | undefined;
        const kill = (kind: NodeJS.Signals) => {
          if (!child.pid) return;
          try {
            if (process.platform === 'win32') child.kill(kind);
            else process.kill(-child.pid, kind);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              failure = '无法终止 Codex 进程。';
          }
        };
        const terminate = () => {
          kill('SIGTERM');
          if (!forceKill) forceKill = setTimeout(() => kill('SIGKILL'), 2500);
        };
        const timeout = setTimeout(() => {
          timedOut = true;
          terminate();
        }, 8 * 60_000);
        signal.addEventListener('abort', terminate, { once: true });
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          bytes += Buffer.byteLength(line);
          if (bytes > 8 * 1024 * 1024) {
            failure = 'Codex 输出超过限制。';
            terminate();
            return;
          }
          let event: {
            type?: string;
            error?: { message?: string };
            message?: string;
            item?: { type?: string };
          };
          try {
            event = JSON.parse(line);
          } catch {
            failure = 'Codex 返回了无效的事件数据。';
            terminate();
            return;
          }
          if (event.type === 'turn.failed' || event.type === 'error')
            failure = event.error?.message ?? event.message ?? 'Codex 执行失败。';
          if (event.type === 'thread.started') onProgress('导读会话已创建。');
          if (event.type === 'turn.completed')
            onProgress('Codex 已返回，正在校验变更覆盖和源码引用…');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-6000);
        });
        child.stdin.on('error', (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure = error.message;
        });
        const cleanup = () => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          signal.removeEventListener('abort', terminate);
          lines.close();
        };
        child.on('error', (error) => {
          cleanup();
          reject(error);
        });
        child.on('close', (code) => {
          cleanup();
          if (signal.aborted) return reject(new AppError(409, '已取消导读。'));
          if (timedOut)
            return reject(new AppError(504, 'Codex 超过 8 分钟未完成，请稍后重试或缩小范围。'));
          if (code !== 0 || failure) {
            const message = failure || stderr || `Codex 退出码 ${code}`;
            if (/usage limit|quota|rate.limit|limit reached/i.test(message))
              return reject(
                new AppError(429, 'Codex 额度或速率已达限制，请等待恢复。未切换到 API 计费。'),
              );
            return reject(new AppError(502, `Codex 调用失败：${message.slice(-1500)}`));
          }
          resolve();
        });
        child.stdin.end(prompt);
        if (signal.aborted) terminate();
      });
      signal.throwIfAborted();
      const output = await readFile(outputPath, 'utf8');
      try {
        return JSON.parse(output);
      } catch {
        throw new AppError(422, 'Codex 最终结果不是有效 JSON，结果未保存。');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
