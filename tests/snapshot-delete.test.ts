import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { ReviewStore } from '../src/server/store.js';
import type { SavedReview, TaskStatus } from '../src/shared/types.js';
import { fixtureGit, makeFixture } from './fixture.js';

test('删除本机快照会清除保存记录，运行中的任务会阻止删除，源码仓库保持不变', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-delete-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  let rejectGeneration: ((error: Error) => void) | undefined;
  const { app, stop } = createApp({
    store,
    provider: { generate: () => new Promise((_resolve, reject) => { rejectGeneration = reject; }) },
    status: async () => ({ available: true, subscription: true, version: 'test', message: 'test' }),
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

  const sourceState = await fixtureGit(fixture.repo, 'status', '--porcelain');
  const created = await call('/api/snapshots', 'POST', {
    repo: fixture.repo, base: fixture.base, target: fixture.target,
  });
  assert.equal(created.status, 200);
  const reviewId = (created.body as SavedReview).snapshot.id;
  const started = await call(`/api/reviews/${reviewId}/guide`, 'POST');
  assert.equal(started.status, 202);
  const taskId = (started.body as TaskStatus).id;
  assert.equal((await call(`/api/reviews/${reviewId}`, 'DELETE')).status, 409);

  assert.ok(rejectGeneration);
  rejectGeneration(new Error('测试任务结束'));
  let state: TaskStatus | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    state = (await call(`/api/tasks/${taskId}`)).body as TaskStatus;
    if (state.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state?.state, 'failed');
  assert.equal((await call(`/api/reviews/${reviewId}`, 'DELETE')).status, 200);
  assert.equal((await call(`/api/reviews/${reviewId}`)).status, 404);
  assert.equal((await call(`/api/reviews/${reviewId}`, 'DELETE')).status, 404);
  assert.equal((await call('/api/reviews')).body.length, 0);

  const recreated = await call('/api/snapshots', 'POST', {
    repo: fixture.repo, base: fixture.base, target: fixture.target,
  });
  assert.equal((recreated.body as SavedReview).snapshot.id, reviewId);
  assert.equal((recreated.body as SavedReview).guide, null);
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain'), sourceState);
});
