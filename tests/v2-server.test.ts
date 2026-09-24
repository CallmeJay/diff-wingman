import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { ReviewStore } from '../src/server/store.js';
import type { SavedReview } from '../src/shared/types.js';
import { makeFixture } from './fixture.js';

test('提交前 HTTP 流程：显式纳入文件、需求对照及过期快照', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v2-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(fixture.repo, 'src/submit.ts'), 'export const changed = true;\n');
  await writeFile(path.join(fixture.repo, 'new.ts'), 'export const extra = true;\n');
  const { app, stop } = createApp({
    store: new ReviewStore(directory),
    provider: {
      async generate({ schema }) {
        if (!schema) throw new Error('missing schema');
        return { bad: true };
      },
    },
    status: async () => ({ available: true, subscription: true, version: 'test', message: 'test' }),
  });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    stop();
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = (await fetch(`${origin}/api/bootstrap`).then((res) => res.json())) as {
    token: string;
  };
  const call = async (url: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${origin}${url}`, {
      method,
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const untracked = await call('/api/untracked', 'POST', { repo: fixture.repo });
  assert.deepEqual(untracked.body, ['new.ts']);
  const created = await call('/api/snapshots', 'POST', {
    repo: fixture.repo,
    mode: 'working',
    untracked: ['new.ts'],
    requirements: '失败后恢复状态',
    preserve: '原始异常仍向外传播',
  });
  assert.equal(created.status, 200);
  const review = created.body as SavedReview;
  assert.equal(review.snapshot.requirements?.[0].text, '失败后恢复状态');
  assert.equal(review.snapshot.requirements?.[1].kind, 'preserve');
  assert.equal(review.snapshot.files.find((file) => file.path === 'new.ts')?.status, 'A');
  assert.equal((await call(`/api/reviews/${review.snapshot.id}/freshness`)).body.fresh, true);

  assert.equal((await call(`/api/reviews/${review.snapshot.id}/states`, 'PUT', {})).status, 404);
  await writeFile(path.join(fixture.repo, 'src/submit.ts'), 'export const changed = false;\n');
  assert.equal((await call(`/api/reviews/${review.snapshot.id}/freshness`)).body.fresh, false);
  const refreshed = await call('/api/snapshots', 'POST', {
    repo: fixture.repo,
    mode: 'working',
    untracked: ['new.ts'],
    requirements: '失败后恢复状态',
    preserve: '原始异常仍向外传播',
  });
  assert.notEqual((refreshed.body as SavedReview).snapshot.id, review.snapshot.id);
});
