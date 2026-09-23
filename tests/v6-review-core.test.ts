import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { createSnapshot } from '../src/server/git.js';
import { ReviewStore } from '../src/server/store.js';
import { fileFingerprint } from '../src/shared/review-core.js';
import type { ReviewFile, SavedReview } from '../src/shared/types.js';
import { currentFileStatus, fileCategory, fileStatusCounts, filterFiles, defaultFileFilters } from '../src/web/file-review.js';
import { makeFixture } from './fixture.js';

function sampleFile(index: number): ReviewFile {
  return {
    id: `file-${index}`, status: 'M', oldPath: `src/file-${index}.ts`, path: `src/file-${index}.ts`,
    oldOid: `old-${index}`, newOid: `new-${index}`, oldMode: '100644', newMode: '100644',
    before: 'before\n', after: 'after\n', additions: 1, deletions: 1, issue: null,
    changes: [{ id: `file-${index}:hunk-1`, fileId: `file-${index}`, label: '@@ -1,1 +1,1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, refIds: [] }],
  };
}

test('100 文件的状态、筛选与内容身份：旧状态不继承到变化后的文件', () => {
  const files = Array.from({ length: 100 }, (_, index) => sampleFile(index + 1));
  const review: SavedReview = {
    snapshot: { id: 'a'.repeat(32), repo: '/fixture', base: 'base', target: 'target', baseLabel: 'base', targetLabel: 'target', createdAt: '', files, refs: [], gaps: [] },
    guide: { overview: '', groups: [], unreviewed: [{ changeId: files[90].changes[0].id, reason: '未分析' }], limitations: [] },
    notes: {}, answers: [], fileStates: {},
    localComments: [{ id: 'one', fileId: files[92].id, fingerprint: fileFingerprint(files[92]), path: files[92].path, side: 'after', line: 1, body: '问题', evidence: '依据', createdAt: '', updatedAt: '' }],
  };
  for (const file of files.slice(0, 60)) review.fileStates![file.id] = { status: 'reviewed', fingerprint: fileFingerprint(file), updatedAt: '' };
  for (const file of files.slice(60, 70)) review.fileStates![file.id] = { status: 'question', fingerprint: fileFingerprint(file), updatedAt: '' };
  for (const file of files.slice(70, 80)) review.fileStates![file.id] = { status: 'in_progress', fingerprint: fileFingerprint(file), updatedAt: '' };
  assert.deepEqual(fileStatusCounts(review, true), { reviewed: 60, question: 10, unreviewed: 30 });
  assert.equal(filterFiles(review, { ...defaultFileFilters, status: 'unread' }, true).length, 20);
  assert.equal(filterFiles(review, { ...defaultFileFilters, status: 'unreviewed' }, true).length, 30);
  assert.equal(filterFiles(review, { ...defaultFileFilters, pending: true }, true).length, 11);
  assert.deepEqual(filterFiles(review, { ...defaultFileFilters, comments: true }, true).map((item) => item.id), [files[92].id]);
  assert.deepEqual(filterFiles(review, { ...defaultFileFilters, query: 'fl93' }, true).map((item) => item.id), [files[92].id]);
  files[0].newOid = 'changed-content';
  assert.equal(currentFileStatus(review, files[0], true), 'unread');
  assert.equal(currentFileStatus(review, files[1], false), 'unread');
  assert.deepEqual(fileStatusCounts(review, true), { reviewed: 59, question: 10, unreviewed: 31 });
  assert.equal(fileCategory('pnpm-lock.yaml'), 'lock');
  assert.equal(fileCategory('Gemfile.lock'), 'lock');
  assert.equal(fileCategory('src/submit.test.ts'), 'test');
  assert.equal(fileCategory('src/view.scss'), 'style');
  assert.equal(fileCategory('docs/guide.md'), 'docs');
  assert.equal(fileCategory('tsconfig.json'), 'config');
});

test('文件状态、阅读位置和本地评论绑定固定快照，失败请求不覆盖历史', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v6-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  const { app, stop } = createApp({ store, provider: { async generate() { throw new Error('AI not needed'); } } });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { stop(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await fetch(`${origin}/api/bootstrap`).then((response) => response.json()) as { token: string };
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${origin}${route}`, { method, headers: { 'x-review-token': token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const created = await call('/api/snapshots', 'POST', { repo: fixture.repo, base: fixture.base, target: fixture.target });
  assert.equal(created.status, 200);
  const review = created.body as SavedReview;
  const file = review.snapshot.files.find((item) => item.after && item.changes.some((change) => change.id.includes(':hunk-')))!;
  const fingerprint = fileFingerprint(file);
  const prefix = `/api/reviews/${review.snapshot.id}`;
  assert.equal((await call(`${prefix}/file-states`, 'PUT', { fileId: file.id, fingerprint: 'wrong', status: 'reviewed' })).status, 409);
  const marked = await call(`${prefix}/file-states`, 'PUT', { fileId: file.id, fingerprint, status: 'reviewed' });
  assert.equal(marked.status, 200);
  assert.equal((marked.body as SavedReview).fileStates?.[file.id]?.status, 'reviewed');
  assert.equal((await call(`${prefix}/reading-position`, 'PUT', { fileId: file.id, side: 'after', line: 99999 })).status, 400);
  const position = { fileId: file.id, side: 'after', line: 1, changeId: file.changes.find((change) => change.id.includes(':hunk-'))!.id };
  assert.equal((await call(`${prefix}/reading-position`, 'PUT', position)).status, 200);
  const comment = { fileId: file.id, fingerprint, side: 'after', line: 1, body: '核对状态', evidence: '人工检查' };
  assert.equal((await call(`${prefix}/local-comments`, 'POST', { ...comment, line: 99999 })).status, 400);
  assert.equal((await call(`${prefix}/local-comments`, 'POST', { ...comment, fingerprint: 'wrong' })).status, 409);
  const saved = await call(`${prefix}/local-comments`, 'POST', comment);
  assert.equal(saved.status, 200);
  const record = (saved.body as SavedReview).localComments![0];
  assert.equal(record.fileId, file.id);
  assert.deepEqual((await store.get(review.snapshot.id)).readingPosition, position);
  assert.equal((await call(`${prefix}/local-comments/${record.id}`, 'PUT', { body: '更新问题', evidence: '新依据' })).status, 200);
  assert.equal((await store.get(review.snapshot.id)).localComments![0].body, '更新问题');
  const reversed = await createSnapshot(fixture.repo, fixture.target, fixture.base);
  const other = await store.create(reversed);
  assert.notEqual(other.snapshot.id, review.snapshot.id);
  assert.equal(other.fileStates?.[file.id], undefined);
  assert.equal(other.localComments?.length ?? 0, 0);
  assert.equal((await call(`${prefix}/local-comments/${record.id}`, 'DELETE')).status, 200);
  assert.equal((await store.get(review.snapshot.id)).fileStates?.[file.id]?.status, 'reviewed');

  await appendFile(path.join(fixture.repo, 'src/submit.ts'), '\n// first live change\n');
  const live = await call('/api/snapshots', 'POST', { repo: fixture.repo, mode: 'working' });
  assert.equal(live.status, 200);
  const liveReview = live.body as SavedReview;
  const liveFile = liveReview.snapshot.files[0];
  const livePrefix = `/api/reviews/${liveReview.snapshot.id}`;
  assert.equal((await call(`${livePrefix}/file-states`, 'PUT', { fileId: liveFile.id, fingerprint: fileFingerprint(liveFile), status: 'reviewed' })).status, 200);
  await appendFile(path.join(fixture.repo, 'src/submit.ts'), '// second live change\n');
  assert.equal((await call(`${livePrefix}/freshness`)).body.fresh, false);
  assert.equal((await call(`${livePrefix}/file-states`, 'PUT', { fileId: liveFile.id, fingerprint: fileFingerprint(liveFile), status: 'question' })).status, 409);
  assert.equal((await call(`${livePrefix}/local-comments`, 'POST', { ...comment, fileId: liveFile.id, fingerprint: fileFingerprint(liveFile) })).status, 409);
  assert.equal((await store.get(liveReview.snapshot.id)).fileStates?.[liveFile.id]?.status, 'reviewed');
});
