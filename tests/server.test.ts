import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GenerateOptions, GuideProvider } from '../src/server/codex.js';
import { createApp } from '../src/server/app.js';
import { ReviewStore } from '../src/server/store.js';
import type { Guide, SavedReview, TaskStatus } from '../src/shared/types.js';
import { makeFixture } from './fixture.js';

test('HTTP 端到端：来源保护、真实快照、导读持久化、取消和失败不覆盖旧结果', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-api-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  let invocation:
    | {
        options: GenerateOptions;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const provider: GuideProvider = {
    generate(options) {
      return new Promise((resolve, reject) => {
        invocation = { options, resolve, reject };
      });
    },
  };
  const { app, stop } = createApp({
    store,
    provider,
    status: async () => ({ available: true, subscription: true, version: 'test', message: 'test' }),
  });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    stop();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const bootstrap = (await fetch(`${origin}/api/bootstrap`).then((response) =>
    response.json(),
  )) as { token: string };
  const request = (url: string, method = 'GET', body?: unknown, extra?: Record<string, string>) =>
    fetch(origin + url, {
      method,
      headers: { 'X-Review-Token': bootstrap.token, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await fetch(origin + '/api/reviews')).status, 403);
  assert.equal(
    (await request('/api/reviews', 'GET', undefined, { Origin: 'https://untrusted.example' }))
      .status,
    403,
  );
  // 原生 HTTP 客户端保留 Host；fetch 会重写它，无法验证 DNS rebinding 边界。
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const call = httpRequest(
      origin + '/api/bootstrap',
      { headers: { Host: 'untrusted.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    call.on('error', reject);
    call.end();
  });
  assert.equal(foreignHostStatus, 403);
  const response = await request('/api/snapshots', 'POST', {
    repo: fixture.repo,
    base: fixture.base,
    target: fixture.target,
  });
  assert.equal(response.status, 200);
  const review = (await response.json()) as SavedReview;
  const { snapshot } = review;
  const ids = snapshot.files.flatMap((file) => file.changes.map((change) => change.id));
  const sourceRef = snapshot.refs.find(
    (ref) => ref.path === 'src/submit.ts' && ref.side === 'after',
  )!;
  const statement = {
    text: 'finally 会恢复等待状态。',
    basis: 'source' as const,
    refIds: [sourceRef.id],
  };
  const guide: Guide = {
    overview: '等待状态恢复',
    groups: [
      {
        title: '恢复状态',
        changeIds: ids,
        before: { text: '见修改前片段', basis: 'inference', refIds: [] },
        after: statement,
        notes: [],
        questions: [],
      },
    ],
    unreviewed: [],
    limitations: [],
    requirementLinks: [],
    flowSteps: [],
  };
  const start = await request(`/api/reviews/${snapshot.id}/guide`, 'POST');
  assert.equal(start.status, 202);
  const task = (await start.json()) as TaskStatus;
  assert.ok(invocation!.options.prompt.includes(snapshot.target));
  assert.match(invocation!.options.prompt, /Restore pending state after failed requests/);
  assert.equal((await request(`/api/reviews/${snapshot.id}/guide`, 'POST')).status, 409);
  invocation!.resolve(guide);
  async function waitTask(taskId: string) {
    for (let count = 0; count < 50; count++) {
      const state = (await request(`/api/tasks/${taskId}`).then((response) =>
        response.json(),
      )) as TaskStatus;
      if (state.state !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Task did not finish');
  }
  assert.equal((await waitTask(task.id)).state, 'completed');
  const saved = await store.get(snapshot.id);
  assert.equal(saved.guide?.groups[0].after.text, statement.text);
  assert.deepEqual(saved.commitContext?.messages.map((item) => item.subject), ['Restore pending state after failed requests']);
  const next = (await request(`/api/reviews/${snapshot.id}/guide`, 'POST').then((response) =>
    response.json(),
  )) as TaskStatus;
  assert.equal((await request(`/api/tasks/${next.id}/cancel`, 'POST')).status, 200);
  assert.equal(invocation!.options.signal.aborted, true);
  invocation!.resolve({ bad: 'late result after cancellation' });
  assert.equal((await waitTask(next.id)).state, 'cancelled');
  assert.deepEqual((await store.get(snapshot.id)).guide, saved.guide);
  const bad = (await request(`/api/reviews/${snapshot.id}/guide`, 'POST').then((response) =>
    response.json(),
  )) as TaskStatus;
  const invalid = structuredClone(guide);
  invalid.groups[0].after.refIds = ['not-in-this-snapshot'];
  invocation!.resolve(invalid);
  assert.equal((await waitTask(bad.id)).state, 'failed');
  assert.deepEqual((await store.get(snapshot.id)).guide, saved.guide);
  assert.equal((await request(`/api/reviews/${snapshot.id}/questions`, 'POST', { groupIndex: 0, question: '旧版追问' })).status, 404);
  assert.equal((await request(`/api/reviews/${snapshot.id}/notes`, 'PUT', { key: 'overview', text: '旧版笔记' })).status, 404);
  assert.equal((await request(`/api/reviews/${snapshot.id}/verification-options`)).status, 404);
  assert.equal((await request(`/api/reviews/${snapshot.id}/verifications`, 'POST', {})).status, 404);
});
