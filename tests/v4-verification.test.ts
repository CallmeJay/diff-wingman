import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { createSnapshot } from '../src/server/git.js';
import { ReviewStore } from '../src/server/store.js';
import {
  captureProcess,
  dockerRunArgs,
  materializeCommit,
  verificationScripts,
  type VerificationRunner,
} from '../src/server/verification.js';
import type { Guide, SavedReview } from '../src/shared/types.js';
import { fixtureGit, makeFixture } from './fixture.js';

async function preparedFixture() {
  const fixture = await makeFixture(false);
  await writeFile(
    path.join(fixture.repo, 'package.json'),
    JSON.stringify({ scripts: { 'test:unit': 'node --test tests/unit.test.js', deploy: 'echo forbidden' } }),
  );
  await fixtureGit(fixture.repo, 'add', 'package.json');
  await fixtureGit(fixture.repo, 'commit', '-m', 'Add verification script');
  const target = await fixtureGit(fixture.repo, 'rev-parse', 'HEAD');
  const snapshot = await createSnapshot(fixture.repo, fixture.base, target);
  return { ...fixture, target, snapshot };
}

test('隔离源码只取目标 commit 的 Git blob，不读取工作区或写回被审查仓库', async (t) => {
  const fixture = await preparedFixture();
  t.after(fixture.cleanup);
  await writeFile(path.join(fixture.repo, 'src/submit.ts'), 'WORKTREE_ONLY\n');
  const before = await fixtureGit(fixture.repo, 'status', '--porcelain');
  const scripts = await verificationScripts(fixture.snapshot);
  assert.deepEqual(scripts, [{ name: 'test:unit', body: 'node --test tests/unit.test.js' }]);
  const directory = await materializeCommit(fixture.snapshot);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await readFile(path.join(directory, 'src/submit.ts'), 'utf8');
  assert.match(original, /finally/);
  assert.doesNotMatch(original, /WORKTREE_ONLY/);
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain'), before);
  await assert.rejects(materializeCommit({ ...fixture.snapshot, mode: 'working' }), /只支持两个 commit/);
});

test('目标 commit 含符号链接时拒绝还原，不在宿主机追踪链接', async (t) => {
  const fixture = await makeFixture(true);
  t.after(fixture.cleanup);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  await assert.rejects(materializeCommit(snapshot), /符号链接/);
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain'), '');
});

test('Docker 命令限制网络、权限、资源和源码写入，且只使用镜像 ID', () => {
  const args = dockerRunArgs('/tmp/frozen', `sha256:${'a'.repeat(64)}`, 'test:unit', 'case-1');
  assert.deepEqual(args.slice(0, 4), ['run', '--rm', '--pull', 'never']);
  assert.ok(args.includes('none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('type=bind,src=/tmp/frozen,dst=/workspace,readonly'));
  assert.ok(args.includes('npm_config_ignore_scripts=true'));
  assert.ok(args.includes('--memory'));
  assert.ok(args.includes('--pids-limit'));
  assert.deepEqual(args.slice(-4), ['npm', `sha256:${'a'.repeat(64)}`, 'run', 'test:unit']);
  assert.ok(!args.join(' ').includes('docker.sock'));
});

test('运行输出有上限，超时会结束子进程', async () => {
  const output = await captureProcess(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(100000))'],
    new AbortController().signal,
    5000,
  );
  assert.equal(output.exitCode, 0);
  assert.equal(output.stdout.length, 32 * 1024);
  assert.equal(output.outputTruncated, true);
  const timeout = await captureProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    new AbortController().signal,
    30,
  );
  assert.equal(timeout.timedOut, true);
});

test('接口把失败退出码保存为运行证据，不改变人工判断；导读变化后旧关联待重核', async (t) => {
  const fixture = await preparedFixture();
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v4-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  await store.create(fixture.snapshot);
  const before = fixture.snapshot.refs.find((ref) => ref.side === 'before')!;
  const after = fixture.snapshot.refs.find((ref) => ref.side === 'after' && ref.role === 'change')!;
  const guide: Guide = {
    overview: '检查提交失败路径',
    groups: [{
      title: '提交状态',
      changeIds: fixture.snapshot.files.flatMap((file) => file.changes.map((change) => change.id)),
      before: { text: '旧状态', basis: 'source', refIds: [before.id] },
      after: { text: '新状态', basis: 'source', refIds: [after.id] },
      notes: [],
      questions: ['失败后是否恢复？'],
    }],
    unreviewed: [],
    limitations: [],
  };
  await store.update(fixture.snapshot.id, (review) => { review.guide = guide; });
  const seen: string[] = [];
  let runtimeAvailable = true;
  const verifier: VerificationRunner = {
    async availability() { return { available: runtimeAvailable, reason: '隔离环境不可用', imageId: `sha256:${'b'.repeat(64)}` }; },
    async run(snapshot, scriptName) {
      seen.push(snapshot.target, scriptName);
      return {
        imageId: `sha256:${'b'.repeat(64)}`,
        command: ['npm', 'run', scriptName],
        startedAt: '2026-09-22T00:00:00.000Z',
        finishedAt: '2026-09-22T00:00:01.000Z',
        durationMs: 1000,
        exitCode: 1,
        timedOut: false,
        stdout: '1 test failed',
        stderr: 'AssertionError',
        outputTruncated: false,
      };
    },
  };
  const { app, stop } = createApp({
    store,
    verifier,
    provider: { async generate() { throw new Error('should not run'); } },
  });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { stop(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await fetch(`${origin}/api/bootstrap`).then((res) => res.json()) as { token: string };
  const call = async (url: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${origin}${url}`, {
      method,
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const review = (await call(`/api/reviews/${fixture.snapshot.id}`)).body as SavedReview;
  const options = await call(`/api/reviews/${fixture.snapshot.id}/verification-options`);
  assert.equal(options.body.available, true);
  assert.deepEqual(options.body.scripts, [{ name: 'test:unit', body: 'node --test tests/unit.test.js' }]);
  const input = {
    caseId: 'claim:group:0:after',
    scriptName: 'test:unit',
    trigger: '空字符串输入',
    expected: 'pending 最终为 false',
    guideFingerprint: review.guideFingerprint,
  };
  assert.equal((await call(`/api/reviews/${fixture.snapshot.id}/verifications`, 'POST', {
    ...input, scriptName: 'deploy',
  })).status, 400);
  assert.equal((await call(`/api/reviews/${fixture.snapshot.id}/verifications`, 'POST', {
    ...input, trigger: '   ',
  })).status, 400);
  const started = await call(`/api/reviews/${fixture.snapshot.id}/verifications`, 'POST', input);
  assert.equal(started.status, 202);
  let state = started.body;
  for (let i = 0; i < 30 && state.state === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = (await call(`/api/verifications/${state.id}`)).body;
  }
  assert.equal(state.state, 'completed');
  assert.deepEqual(seen, [fixture.target, 'test:unit']);
  const saved = await store.get(fixture.snapshot.id);
  assert.equal(saved.verificationRecords?.[0].exitCode, 1);
  assert.deepEqual(saved.claimStates, {});
  runtimeAvailable = false;
  assert.equal((await call(`/api/reviews/${fixture.snapshot.id}/verifications`, 'POST', input)).status, 503);
  assert.deepEqual(seen, [fixture.target, 'test:unit']);
  const report = await call(`/api/reviews/${fixture.snapshot.id}/report`);
  assert.match(report.body.markdown, /退出状态：1/);
  assert.match(report.body.markdown, /脚本退出码只表示该命令的运行结果/);
  await store.update(fixture.snapshot.id, (latest) => { latest.guide!.groups[0].after.text = '新的判断'; });
  const stale = await call(`/api/reviews/${fixture.snapshot.id}/report`);
  assert.match(stale.body.markdown, /导读已变化，关联待重核/);
});
