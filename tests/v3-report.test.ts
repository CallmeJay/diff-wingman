import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { createLiveSnapshot } from '../src/server/git.js';
import { ReviewStore } from '../src/server/store.js';
import type { Guide, SavedReview } from '../src/shared/types.js';
import { makeFixture } from './fixture.js';

test('逐条人工判断和报告保持快照、导读、证据边界', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v3-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(fixture.repo, 'src/submit.ts'), 'export const submit = () => 1;\n');
  const requirements = [{ id: 'req-1', kind: 'change' as const, text: '修复 #失败' }];
  const snapshot = await createLiveSnapshot(fixture.repo, 'working', [], requirements);
  const store = new ReviewStore(directory);
  await store.create(snapshot);
  const changes = snapshot.files.flatMap((file) => file.changes.map((change) => change.id));
  const before = snapshot.refs.find((ref) => ref.side === 'before')!;
  const after = snapshot.refs.find((ref) => ref.side === 'after' && ref.role === 'change')!;
  const guide: Guide = {
    overview: '提交行为待人工核对',
    groups: [
      {
        title: '提交状态',
        changeIds: changes,
        before: { text: '旧路径', basis: 'source', refIds: [before.id] },
        after: { text: '新路径', basis: 'source', refIds: [after.id] },
        notes: [],
        questions: ['失败后是否恢复？'],
      },
    ],
    unreviewed: [],
    limitations: ['运行时未验证'],
    requirementLinks: [
      {
        requirementId: 'req-1',
        statement: { text: '对照需要人工复核', basis: 'inference', refIds: [] },
        changeIds: changes,
      },
    ],
    flowSteps: [],
  };
  await store.update(snapshot.id, (review) => {
    review.guide = guide;
  });
  const { app, stop } = createApp({
    store,
    provider: {
      async generate() {
        throw new Error('should not run');
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
  const loaded = (await call(`/api/reviews/${snapshot.id}`)).body as SavedReview;
  const fingerprint = loaded.guideFingerprint!;
  const reportBefore = await call(`/api/reviews/${snapshot.id}/report`);
  assert.equal(reportBefore.status, 200);
  assert.match(reportBefore.body.markdown, /修复 \\#失败/);
  assert.match(reportBefore.body.markdown, /未审查/);
  assert.match(reportBefore.body.markdown, /不代表自动审查通过/);
  assert.doesNotMatch(reportBefore.body.markdown, /分组人工状态|隔离执行记录|脚本运行证据|追问记录/);
  assert.doesNotMatch(reportBefore.body.markdown, /人工状态：人工已确认/);
  assert.equal(
    (
      await call(`/api/reviews/${snapshot.id}/claims`, 'PUT', {
        key: 'group:0:after',
        guideFingerprint: fingerprint,
        status: 'confirmed',
        evidence: '',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/api/reviews/${snapshot.id}/claims`, 'PUT', {
        key: 'group:99:after',
        guideFingerprint: fingerprint,
        status: 'confirmed',
        evidence: '伪造',
      })
    ).status,
    409,
  );
  const saved = await call(`/api/reviews/${snapshot.id}/claims`, 'PUT', {
    key: 'group:0:after',
    guideFingerprint: fingerprint,
    status: 'confirmed',
    evidence: '人工核对了返回值',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.claimStates['group:0:after'].status, 'confirmed');
  const report = await call(`/api/reviews/${snapshot.id}/report`);
  assert.match(report.body.markdown, /人工已确认/);
  assert.match(report.body.markdown, /人工核对了返回值/);
  await store.update(snapshot.id, (review) => {
    review.guide!.groups[0].after.text = '新的导读判断';
  });
  const regenerated = await call(`/api/reviews/${snapshot.id}/report`);
  assert.match(regenerated.body.markdown, /旧记录待重核/);
  assert.equal(
    (
      await call(`/api/reviews/${snapshot.id}/claims`, 'PUT', {
        key: 'group:0:after',
        guideFingerprint: fingerprint,
        status: 'confirmed',
        evidence: '旧导读',
      })
    ).status,
    409,
  );
  await writeFile(path.join(fixture.repo, 'src/submit.ts'), 'export const submit = () => 2;\n');
  const stale = await call(`/api/reviews/${snapshot.id}/report`);
  assert.match(stale.body.markdown, /已变化，旧人工结论待重核/);
  const current = (await call(`/api/reviews/${snapshot.id}`)).body as SavedReview;
  assert.equal(
    (
      await call(`/api/reviews/${snapshot.id}/claims`, 'PUT', {
        key: 'group:0:after',
        guideFingerprint: current.guideFingerprint,
        status: 'confirmed',
        evidence: '旧源码',
      })
    ).status,
    409,
  );
});
