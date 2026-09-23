import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

export async function fixtureGit(repo: string, ...args: string[]): Promise<string> {
  const result = await exec('git', ['-C', repo, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return result.stdout.trim();
}

// 用真实临时仓库验证对象读取；提交只属于测试数据，不提交工具或业务仓库。
export async function makeFixture(edgeCases = true) {
  const repo = await mkdtemp(path.join(tmpdir(), 'review-helper-fixture-'));
  await fixtureGit(repo, 'init', '-b', 'main');
  await fixtureGit(repo, 'config', 'user.name', 'Review Fixture');
  await fixtureGit(repo, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(path.join(repo, 'src'));
  await writeFile(
    path.join(repo, 'src/submit.ts'),
    `import { request } from './transport';
export const state = { pending: false };

export async function submit(value: string) {
  state.pending = true;
  const result = await request(value);
  state.pending = false;
  return result;
}
`,
  );
  await writeFile(
    path.join(repo, 'src/transport.ts'),
    `export async function request(value: string) {
  if (!value) throw new Error('Missing value');
  return { accepted: value };
}
`,
  );
  await writeFile(
    path.join(repo, 'src/panel.ts'),
    `import { submit } from './submit';
export async function onSubmit(value: string) {
  try { return await submit(value); }
  catch { return { error: 'Request failed' }; }
}
`,
  );
  if (edgeCases) {
    await writeFile(path.join(repo, 'obsolete.ts'), 'export const old = true;\n');
    await writeFile(path.join(repo, 'old label.txt'), 'Same content, different path.\n');
    await writeFile(path.join(repo, 'notes:a\nb.md'), 'before\n');
  }
  await fixtureGit(repo, 'add', '.');
  await fixtureGit(repo, 'commit', '-m', 'Add initial fixture');
  const base = await fixtureGit(repo, 'rev-parse', 'HEAD');
  await writeFile(
    path.join(repo, 'src/submit.ts'),
    `import { request } from './transport';
export const state = { pending: false };

export async function submit(value: string) {
  state.pending = true;
  try {
    return await request(value);
  } finally {
    // 成功或失败后都结束等待状态，异常继续交给调用方处理。
    state.pending = false;
  }
}
`,
  );
  await writeFile(
    path.join(repo, 'src/submit.test.ts'),
    `import { strict as assert } from 'node:assert';
import { submit, state } from './submit';

export async function checkFailure() {
  await assert.rejects(() => submit(''), /Missing value/);
  assert.equal(state.pending, false);
}
`,
  );
  if (edgeCases) {
    await rm(path.join(repo, 'obsolete.ts'));
    await rename(path.join(repo, 'old label.txt'), path.join(repo, 'new label.txt'));
    await writeFile(path.join(repo, 'notes:a\nb.md'), 'after\n');
    await writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 255, 2]));
    await writeFile(path.join(repo, 'large.txt'), 'x'.repeat(300 * 1024));
    await symlink('/etc/hosts', path.join(repo, 'outside-link'));
  }
  await fixtureGit(repo, 'add', '.');
  await fixtureGit(repo, 'commit', '-m', 'Restore pending state after failed requests');
  const target = await fixtureGit(repo, 'rev-parse', 'HEAD');
  return { repo, base, target, cleanup: () => rm(repo, { recursive: true, force: true }) };
}
