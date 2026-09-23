import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { mergeGuideBatches, planGuideBatches, validateGuide } from '../src/server/guide.js';
import { ReviewStore } from '../src/server/store.js';
import type { Guide, Snapshot, TaskStatus } from '../src/shared/types.js';

function largeSnapshot(): Snapshot {
  const files: Snapshot['files'] = [];
  const refs: Snapshot['refs'] = [];
  for (let index = 1; index <= 5; index++) {
    const fileId = `file-${index}`;
    const filePath = `src/file-${index}.ts`;
    const changeId = `${fileId}:hunk-1`;
    const refId = `ref-${index}`;
    files.push({
      id: fileId,
      status: 'M',
      oldPath: filePath,
      path: filePath,
      oldOid: 'a'.repeat(40),
      newOid: 'b'.repeat(40),
      oldMode: '100644',
      newMode: '100644',
      before: '',
      after: '',
      additions: 1,
      deletions: 0,
      issue: null,
      changes: [{
        id: changeId,
        fileId,
        label: '@@ -1,0 +1,1 @@',
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        refIds: [refId],
      }],
    });
    refs.push({
      id: refId,
      side: 'after',
      path: filePath,
      blobOid: 'b'.repeat(40),
      startLine: 1,
      endLine: 4000,
      code: 'const value = 1;\n'.repeat(4000),
      role: 'change',
      label: '变更上下文',
    });
  }
  return {
    id: 'a'.repeat(32),
    repo: '/tmp/batch-guide-fixture',
    base: 'a'.repeat(40),
    target: 'b'.repeat(40),
    baseLabel: 'base',
    targetLabel: 'target',
    createdAt: new Date().toISOString(),
    files,
    refs,
    gaps: [],
    requirements: [],
  };
}

function guideFor(part: Snapshot, index: number): Guide {
  const ids = part.files.flatMap((file) => file.changes.map((change) => change.id));
  const refId = part.refs[0].id;
  return {
    overview: `第 ${index + 1} 批变更`,
    groups: [{
      title: `分组 ${index + 1}`,
      changeIds: ids,
      before: { text: '修改前待核对', basis: 'inference', refIds: [] },
      after: { text: '修改后片段', basis: 'source', refIds: [refId] },
      notes: [],
      questions: [],
    }],
    unreviewed: [],
    limitations: [],
    requirementLinks: (part.requirements ?? []).map((item) => ({
      requirementId: item.id,
      statement: index === 0
        ? { text: '本批有对应片段', basis: 'source' as const, refIds: [refId] }
        : { text: '本批仍需核对', basis: 'inference' as const, refIds: [] },
      changeIds: index === 0 && item.kind === 'change' ? [ids[0]] : [],
    })),
    flowSteps: [{
      groupIndex: 0,
      stage: '结果',
      statement: { text: '修改后片段', basis: 'source', refIds: [refId] },
    }],
  };
}

test('大快照完整分批、合并后保留全量变更和需求对照', () => {
  const snapshot = largeSnapshot();
  snapshot.requirements = [
    { id: 'req-change', kind: 'change', text: '修改逻辑' },
    { id: 'req-preserve', kind: 'preserve', text: '保留原行为' },
  ];
  const batches = planGuideBatches(snapshot);
  assert.ok(batches.length >= 3);
  assert.ok(batches.every((batch) => batch.prompt.length <= 180_000));
  assert.equal(batches.flatMap((batch) => batch.snapshot.files).length, snapshot.files.length);
  assert.deepEqual(
    new Set(batches.flatMap((batch) => batch.snapshot.refs.map((ref) => ref.id))),
    new Set(snapshot.refs.map((ref) => ref.id)),
  );
  const guides = batches.map((batch, index) =>
    validateGuide(guideFor(batch.snapshot, index), batch.snapshot),
  );
  const merged = validateGuide(mergeGuideBatches(guides), snapshot);
  assert.equal(merged.groups.length, batches.length);
  assert.deepEqual(merged.flowSteps?.map((step) => step.groupIndex), batches.map((_, i) => i));
  assert.equal(merged.requirementLinks?.[0].statement.basis, 'inference');
  assert.equal(merged.requirementLinks?.[0].changeIds.length, 1);
  assert.match(merged.limitations.join(' '), /跨批次/);
  assert.throws(() =>
    planGuideBatches({ ...snapshot, refs: [...snapshot.refs, {
      ...snapshot.refs[0], id: 'unlinked', path: 'other.ts', relatedChangeIds: [],
    }] }),
  /无法归入/);
});

test('分批任务顺序调用；后批失败或取消不覆盖已有导读', async (t) => {
  const snapshot = largeSnapshot();
  const directory = await mkdtemp(path.join(tmpdir(), 'review-batch-guide-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  await store.create(snapshot);
  let calls = 0;
  let failAt = 0;
  let blockAt = 0;
  let releaseBlocked: (() => void) | undefined;
  const { app, stop } = createApp({
    store,
    provider: {
      async generate({ prompt }) {
        calls++;
        if (calls === failAt) throw new Error('第二批失败');
        const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as {
          context: { changes: { path: string }[]; refs: Snapshot['refs'] };
        };
        const part = {
          ...snapshot,
          files: snapshot.files.filter((file) => data.context.changes.some((item) => item.path === file.path)),
          refs: data.context.refs,
        };
        const result = guideFor(part, calls - 1);
        if (calls === blockAt)
          return new Promise((resolve) => { releaseBlocked = () => resolve(result); });
        return result;
      },
    },
    status: async () => ({ available: true, subscription: true, version: 'test', message: 'test' }),
  });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { stop(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await fetch(`${origin}/api/bootstrap`).then((res) => res.json()) as { token: string };
  const call = (url: string, method = 'GET') => fetch(`${origin}${url}`, {
    method,
    headers: { 'x-review-token': token },
  });
  const wait = async (id: string) => {
    for (let count = 0; count < 50; count++) {
      const state = await call(`/api/tasks/${id}`).then((res) => res.json()) as TaskStatus;
      if (state.state !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Task did not finish');
  };
  const first = await call(`/api/reviews/${snapshot.id}/guide`, 'POST').then((res) => res.json()) as TaskStatus;
  assert.equal((await wait(first.id)).state, 'completed');
  assert.equal(calls, planGuideBatches(snapshot).length);
  const saved = (await store.get(snapshot.id)).guide;
  assert.equal(saved?.groups.length, calls);
  calls = 0;
  failAt = 2;
  const retry = await call(`/api/reviews/${snapshot.id}/guide`, 'POST').then((res) => res.json()) as TaskStatus;
  assert.equal((await wait(retry.id)).state, 'failed');
  assert.equal(calls, 2);
  assert.deepEqual((await store.get(snapshot.id)).guide, saved);
  calls = 0;
  failAt = 0;
  blockAt = 2;
  const cancelled = await call(`/api/reviews/${snapshot.id}/guide`, 'POST').then((res) => res.json()) as TaskStatus;
  for (let count = 0; count < 50 && !releaseBlocked; count++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseBlocked);
  assert.equal((await call(`/api/tasks/${cancelled.id}/cancel`, 'POST')).status, 200);
  releaseBlocked();
  assert.equal((await wait(cancelled.id)).state, 'cancelled');
  assert.equal(calls, 2);
  assert.deepEqual((await store.get(snapshot.id)).guide, saved);
});
