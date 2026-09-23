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
import type { Guide, SavedReview, VerificationTaskStatus } from '../src/shared/types.js';
import { DockerVerifier } from '../src/server/verification.js';
import { fixtureGit, makeFixture } from './fixture.js';

test('真实 Docker：固定 commit、只读源码、无网络及成功/失败证据', async (t) => {
  const verifier = new DockerVerifier();
  const availability = await verifier.availability();
  assert.equal(availability.available, true, availability.reason);
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const boundaryScript = `const fs = require('node:fs');
const net = require('node:net');
if (!fs.readFileSync('src/submit.ts', 'utf8').includes('finally')) process.exit(10);
try { fs.writeFileSync('probe.txt', 'unexpected'); process.exit(11); }
catch (error) { if (!['EROFS', 'EACCES'].includes(error.code)) process.exit(12); }
const socket = net.connect({ host: '1.1.1.1', port: 80 });
socket.once('connect', () => process.exit(13));
socket.once('error', (error) => {
  if (!['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)) process.exit(14);
  console.log('BOUNDARY_OK');
  process.exit(0);
});
setTimeout(() => process.exit(15), 5000);
`;
  await writeFile(path.join(fixture.repo, 'boundary.cjs'), boundaryScript);
  await writeFile(
    path.join(fixture.repo, 'package.json'),
    JSON.stringify({ scripts: {
      'pretest:boundary': 'echo SHOULD_NOT_RUN',
      'test:boundary': 'node boundary.cjs',
      'test:fail': 'node -e "console.error(\'EXPECTED_FAILURE\'); process.exit(7)"',
    } }),
  );
  await fixtureGit(fixture.repo, 'add', 'boundary.cjs', 'package.json');
  await fixtureGit(fixture.repo, 'commit', '-m', 'Add isolated verification checks');
  const target = await fixtureGit(fixture.repo, 'rev-parse', 'HEAD');
  const snapshot = await createSnapshot(fixture.repo, fixture.base, target);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v4-docker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  await store.create(snapshot);
  const beforeRef = snapshot.refs.find((ref) => ref.side === 'before')!;
  const afterRef = snapshot.refs.find((ref) => ref.side === 'after' && ref.role === 'change')!;
  const guide: Guide = {
    overview: '验证固定源码和隔离边界',
    groups: [{
      title: '固定 commit',
      changeIds: snapshot.files.flatMap((file) => file.changes.map((change) => change.id)),
      before: { text: '旧源码', basis: 'source', refIds: [beforeRef.id] },
      after: { text: '目标提交中的源码', basis: 'source', refIds: [afterRef.id] },
      notes: [],
      questions: ['容器是否只读且无网络？'],
    }],
    unreviewed: [],
    limitations: [],
  };
  await store.update(snapshot.id, (review) => { review.guide = guide; });
  await writeFile(path.join(fixture.repo, 'src/submit.ts'), 'WORKTREE_ONLY\n');
  const hostStatus = await fixtureGit(fixture.repo, 'status', '--porcelain');
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
  const review = (await call(`/api/reviews/${snapshot.id}`)).body as SavedReview;
  const options = await call(`/api/reviews/${snapshot.id}/verification-options`);
  assert.equal(options.body.available, true);
  assert.deepEqual(options.body.scripts.map((item: { name: string }) => item.name), [
    'test:boundary', 'test:fail',
  ]);
  const run = async (scriptName: string) => {
    const started = await call(`/api/reviews/${snapshot.id}/verifications`, 'POST', {
      caseId: 'claim:group:0:after',
      scriptName,
      trigger: '运行目标 commit 的合成检查',
      expected: scriptName === 'test:boundary' ? '只读、无网络且读取旧 commit' : '退出码为 7',
      guideFingerprint: review.guideFingerprint,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    let state = started.body as VerificationTaskStatus;
    for (let index = 0; index < 120 && state.state === 'running'; index++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = (await call(`/api/verifications/${state.id}`)).body as VerificationTaskStatus;
    }
    assert.equal(state.state, 'completed', state.error ?? '验证任务未完成');
    return (await store.get(snapshot.id)).verificationRecords!.at(-1)!;
  };
  const success = await run('test:boundary');
  assert.equal(success.exitCode, 0, success.stderr);
  assert.match(success.stdout, /BOUNDARY_OK/);
  assert.doesNotMatch(success.stdout, /SHOULD_NOT_RUN/);
  assert.equal(success.imageId, availability.imageId);
  assert.equal(success.snapshotId, snapshot.id);
  assert.equal(success.target, target);
  const failure = await run('test:fail');
  assert.equal(failure.exitCode, 7);
  assert.match(failure.stderr, /EXPECTED_FAILURE/);
  const report = await call(`/api/reviews/${snapshot.id}/report`);
  assert.match(report.body.markdown, /BOUNDARY\\_OK/);
  assert.match(report.body.markdown, /退出状态：7/);
  assert.deepEqual((await store.get(snapshot.id)).claimStates, {});
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain'), hostStatus);
  assert.equal(await readFile(path.join(fixture.repo, 'src/submit.ts'), 'utf8'), 'WORKTREE_ONLY\n');
});
