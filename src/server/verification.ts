import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { TextDecoder } from 'node:util';
import { listClaims } from '../shared/claims.js';
import type { SavedReview, Snapshot, VerificationCase } from '../shared/types.js';
import { AppError } from './errors.js';
import { git } from './git.js';

const exec = promisify(execFile);
const image = process.env.REVIEW_HELPER_VERIFY_IMAGE ?? 'node:22-alpine';
const MAX_FILES = 2500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 32 * 1024;
const RUN_TIMEOUT = 120_000;
const scriptPattern = /^(?:test|check|lint|typecheck|verify)(?::[A-Za-z0-9_.:-]+)?$/;

export interface VerificationScript {
  name: string;
  body: string;
}

export interface RunEvidence {
  imageId: string;
  command: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface VerificationRunner {
  availability(): Promise<{ available: boolean; reason: string; imageId: string }>;
  run(snapshot: Snapshot, scriptName: string, signal: AbortSignal): Promise<RunEvidence>;
}

// 候选任务只重述导读中的待核对判断和问题；脚本退出码不能替代人工业务结论。
export function verificationCases(review: SavedReview): VerificationCase[] {
  if (!review.guide) return [];
  const claims = listClaims(review.guide).map((claim) => ({
    id: `claim:${claim.key}`,
    title: claim.label,
    focus: claim.statement.text,
    refIds: claim.statement.refIds,
    unresolved:
      review.claimStates?.[claim.key]?.status !== 'confirmed' ||
      review.claimStates?.[claim.key]?.guideFingerprint !== review.guideFingerprint,
  }));
  const questions = review.guide.groups.flatMap((group, groupIndex) =>
    group.questions.map((question, questionIndex) => ({
      id: `question:${groupIndex}:${questionIndex}`,
      title: `${group.title} · 待核对问题 ${questionIndex + 1}`,
      focus: question,
      refIds: [],
      unresolved: true,
    })),
  );
  return [...claims, ...questions];
}

// 只读取目标 commit 根目录的检查脚本，绝不从当前工作区取得命令。
export async function verificationScripts(snapshot: Snapshot): Promise<VerificationScript[]> {
  if (snapshot.mode && snapshot.mode !== 'commits') return [];
  const tree = await git(snapshot.repo, ['ls-tree', '-z', snapshot.target, '--', 'package.json']);
  if (!tree.length) return [];
  const raw = await git(snapshot.repo, ['cat-file', 'blob', `${snapshot.target}:package.json`], 256 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, '目标 commit 的 package.json 不是有效 JSON。');
  }
  const scripts =
    parsed && typeof parsed === 'object' && 'scripts' in parsed
      ? (parsed as { scripts: unknown }).scripts
      : undefined;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return [];
  return Object.entries(scripts)
    .filter(
      ([name, body]) =>
        scriptPattern.test(name) && typeof body === 'string' && body.length <= 4000,
    )
    .map(([name, body]) => ({ name, body: body as string }));
}

// 从 Git blob 逐个还原目标树；拒绝链接、子模块和异常路径，避免临时目录写出界。
export async function materializeCommit(snapshot: Snapshot, signal?: AbortSignal): Promise<string> {
  if (snapshot.mode && snapshot.mode !== 'commits')
    throw new AppError(400, '第四版目前只支持两个 commit 的固定快照。');
  const directory = await mkdtemp(path.join(tmpdir(), 'review-verify-'));
  const deadline = Date.now() + 120_000;
  try {
    const raw = await git(snapshot.repo, ['ls-tree', '-r', '-z', '-l', '--full-tree', snapshot.target]);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const entries = raw.length
      ? raw.subarray(0, raw.length - (raw.at(-1) === 0 ? 1 : 0)).toString('binary').split('\0')
      : [];
    if (entries.length > MAX_FILES) throw new AppError(413, `目标 commit 超过 ${MAX_FILES} 个文件，无法隔离执行。`);
    let total = 0;
    for (const entry of entries) {
      if (signal?.aborted) throw new AppError(409, '验证任务已取消。');
      if (Date.now() > deadline) throw new AppError(408, '固定源码还原超时。');
      const bytes = Buffer.from(entry, 'binary');
      const divider = bytes.indexOf(9);
      if (divider < 0) throw new AppError(400, '目标 commit 的文件清单格式异常。');
      const header = bytes.subarray(0, divider).toString('ascii');
      const match = /^(100644|100755) blob ([a-f0-9]{40,64})\s+(\d+)$/.exec(header);
      if (!match) throw new AppError(400, '目标 commit 含符号链接、子模块或不支持的文件模式。');
      const relative = decoder.decode(bytes.subarray(divider + 1));
      const parts = relative.split('/');
      if (
        relative.startsWith('/') ||
        parts.some((part) => !part || part === '.' || part === '..' || part === '.git')
      )
        throw new AppError(400, '目标 commit 含不安全的文件路径。');
      const size = Number(match[3]);
      total += size;
      if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES)
        throw new AppError(413, '目标 commit 超出隔离执行的文件大小上限。');
      const content = await git(snapshot.repo, ['cat-file', 'blob', match[2]], size + 64 * 1024);
      if (content.length !== size) throw new AppError(409, 'Git 对象大小与目标 commit 不一致。');
      const destination = path.join(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { mode: match[1] === '100755' ? 0o755 : 0o644 });
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function dockerRunArgs(
  directory: string,
  imageId: string,
  scriptName: string,
  containerName: string,
): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new AppError(503, '当前系统不支持隔离运行所需的用户身份。');
  return [
    'run', '--rm', '--pull', 'never', '--name', containerName,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '64',
    '--memory', '512m', '--cpus', '1', '--user', `${uid}:${gid}`,
    '--mount', `type=bind,src=${directory},dst=/workspace,readonly`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'CI=1',
    '--env', 'npm_config_cache=/tmp/npm-cache', '--env', 'npm_config_offline=true',
    '--env', 'npm_config_ignore_scripts=true',
    '--entrypoint', 'npm', imageId, 'run', scriptName,
  ];
}

export async function captureProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const collect = (current: Buffer, chunk: Buffer) => {
      if (current.length + chunk.length > OUTPUT_LIMIT) outputTruncated = true;
      return Buffer.concat([current, chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - current.length))]);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', abort);
      resolve({
        exitCode: code,
        timedOut,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        outputTruncated,
      });
    });
    if (signal.aborted) abort();
  });
}

export class DockerVerifier implements VerificationRunner {
  async availability(): Promise<{ available: boolean; reason: string; imageId: string }> {
    try {
      await exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000 });
      const result = await exec('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
        timeout: 4000,
      });
      const imageId = result.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('镜像身份格式异常');
      return { available: true, reason: '', imageId };
    } catch {
      return {
        available: false,
        reason: `Docker 未运行或本地缺少镜像 ${image}；不会拉取镜像或在宿主机执行项目脚本。`,
        imageId: '',
      };
    }
  }

  async run(snapshot: Snapshot, scriptName: string, signal: AbortSignal): Promise<RunEvidence> {
    const available = await this.availability();
    if (!available.available) throw new AppError(503, available.reason);
    const directory = await materializeCommit(snapshot, signal);
    const containerName = `review-verify-${randomUUID()}`;
    const command = ['npm', 'run', scriptName];
    const startedAt = new Date();
    try {
      const result = await captureProcess(
        'docker',
        dockerRunArgs(directory, available.imageId, scriptName, containerName),
        signal,
        RUN_TIMEOUT,
      );
      if (result.timedOut || signal.aborted) {
        try {
          await exec('docker', ['rm', '-f', containerName], { timeout: 5000 });
        } catch (error) {
          if (!/No such container/.test(String(error)))
            throw new AppError(500, '隔离容器停止状态无法确认，请检查 Docker。');
        }
      }
      if (signal.aborted) throw new AppError(409, '验证任务已取消。');
      const finishedAt = new Date();
      return {
        imageId: available.imageId,
        command,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        ...result,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
