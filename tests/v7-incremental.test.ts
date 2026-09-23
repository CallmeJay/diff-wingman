import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { createApp } from '../src/server/app.js';
import { createSnapshot } from '../src/server/git.js';
import { changedLines, type GitLabReader } from '../src/server/gitlab.js';
import { ReviewStore } from '../src/server/store.js';
import { compareMrVersions, hunkFingerprint, inheritMrReview } from '../src/shared/incremental.js';
import type { GitLabMergeRequest, ReviewFile, SavedReview } from '../src/shared/types.js';
import { fileFingerprint } from '../src/shared/review-core.js';
import { fixtureGit, makeFixture } from './fixture.js';

const digest = (value: string) => createHash('sha1').update(value).digest('hex');
const mrUrl = 'https://gitlab.example.com/group/project/-/merge_requests/7';

function file(id: string, before: string, after: string): ReviewFile {
  const hunks = structuredPatch('src/code.ts', 'src/code.ts', before, after, '', '', { context: 3 }).hunks;
  return { id, status: 'M', oldPath: 'src/code.ts', path: 'src/code.ts',
    oldOid: digest(before), newOid: digest(after), oldMode: '100644', newMode: '100644',
    before, after, additions: 0, deletions: 0, issue: null,
    changes: hunks.map((hunk, index) => ({ id: `${id}:hunk-${index + 1}`, fileId: id,
      label: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, refIds: [] })) };
}

function review(id: string, versionId: number, source: ReviewFile): SavedReview {
  return { snapshot: { id, repo: '/repo', base: 'a'.repeat(40), target: digest(String(versionId)),
    baseLabel: 'base', targetLabel: 'head', createdAt: '', files: [source], refs: [], gaps: [] },
    gitlab: { url: mrUrl, projectPath: 'group/project', iid: 7, title: 'Review', versionId,
      baseSha: 'a'.repeat(40), headSha: digest(String(versionId)), startSha: 'a'.repeat(40), files: [] },
    guide: null, notes: {}, answers: [] };
}

test('只有唯一且逐字相同的 hunk 继承；重复变更内容不迁移评论', () => {
  const before = ['old', ...Array(12).fill('gap'), 'old', ''].join('\n');
  const after = ['new', ...Array(12).fill('gap'), 'new', ''].join('\n');
  const old = review('a'.repeat(32), 11, file('file-1', before, after));
  const next = review('b'.repeat(32), 12, file('file-1', `prefix\n${before}`, `prefix\n${after}`));
  const oldHunks = old.snapshot.files[0].changes;
  assert.equal(oldHunks.length, 2);
  old.hunkStates = Object.fromEntries(oldHunks.map((change) => [change.id,
    { status: 'reviewed', fingerprint: hunkFingerprint(old.snapshot.files[0], change), updatedAt: '' }]));
  old.localComments = [{ id: 'comment-1', fileId: 'file-1', fingerprint: fileFingerprint(old.snapshot.files[0]),
    path: 'src/code.ts', side: 'after', line: 1, body: '核对', evidence: '人工依据', createdAt: '', updatedAt: '' }];
  const comparison = compareMrVersions(old, next);
  assert.equal(comparison.files[0].status, 'modified');
  assert.ok(comparison.files[0].hunks.every((hunk) => hunk.status === 'ambiguous'));
  inheritMrReview(old, next, comparison);
  assert.equal(Object.keys(next.hunkStates ?? {}).length, 0);
  assert.equal(next.localComments?.[0].anchorStatus, 'pending');
  assert.equal(old.localComments?.[0].line, 1);
});

test('同文件只改一个 hunk：另一块精确继承，评论按位移定位，文件整体待复审', () => {
  const gap = Array(12).fill('gap');
  const before = ['oldA', ...gap, 'oldB', ''].join('\n');
  const after = ['newA', ...gap, 'newB', ''].join('\n');
  const old = review('c'.repeat(32), 11, file('file-1', before, after));
  const next = review('d'.repeat(32), 12, file('file-1', `prefix\n${before}`, `prefix\n${after.replace('newB', 'newerB')}`));
  const [first, second] = old.snapshot.files[0].changes;
  old.fileStates = { 'file-1': { status: 'reviewed', fingerprint: fileFingerprint(old.snapshot.files[0]), updatedAt: '' } };
  old.hunkStates = Object.fromEntries([first, second].map((change) => [change.id,
    { status: 'reviewed', fingerprint: hunkFingerprint(old.snapshot.files[0], change), updatedAt: '' }]));
  old.localComments = [{ id: 'comment-1', fileId: 'file-1', fingerprint: fileFingerprint(old.snapshot.files[0]),
    path: 'src/code.ts', side: 'after', line: 1, body: '核对第一块', evidence: '人工依据', createdAt: '', updatedAt: '' }];
  const comparison = compareMrVersions(old, next);
  assert.deepEqual(comparison.files[0].hunks.map((item) => item.status), ['unchanged', 'new']);
  inheritMrReview(old, next, comparison);
  assert.equal(next.fileStates?.['file-1'], undefined);
  assert.equal(next.hunkStates?.['file-1:hunk-1']?.status, 'reviewed');
  assert.equal(next.hunkStates?.['file-1:hunk-2'], undefined);
  assert.equal(next.localComments?.[0].anchorStatus, 'current');
  assert.equal(next.localComments?.[0].line, 2);
});

test('真实 MR 固定快照：未变文件继承，变化文件待复审，多行和文件级草稿按契约校验', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v7-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  let versionId = 11;
  let headSha = fixture.target;
  const binding = async (): Promise<GitLabMergeRequest> => {
    const snapshot = await createSnapshot(fixture.repo, fixture.base, headSha);
    const files = await Promise.all(snapshot.files.map(async (item) => {
      const patch = await fixtureGit(fixture.repo, 'diff', fixture.base, headSha, '--', item.path);
      return { path: item.path, oldPath: item.oldPath, ...changedLines(patch.slice(patch.indexOf('@@'))) };
    }));
    return { url: mrUrl, projectPath: 'group/project', iid: 7, title: 'Review', versionId,
      baseSha: fixture.base, headSha, startSha: fixture.base,
      files };
  };
  const reader: GitLabReader = { load: async () => binding(), current: async (value) => value.versionId === versionId };
  const { app, stop } = createApp({ store, gitlab: reader,
    provider: { async generate() { throw new Error('AI not needed'); } } });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { stop(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = await fetch(`${origin}/api/bootstrap`).then((response) => response.json()) as { token: string };
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${origin}${route}`, { method,
      headers: { 'x-review-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const input = { repo: fixture.repo, url: mrUrl };
  const first = (await call('/api/gitlab/import', 'POST', input)).body as SavedReview;
  const stable = first.snapshot.files.find((item) => item.path === 'src/submit.test.ts')!;
  const changed = first.snapshot.files.find((item) => item.path === 'src/submit.ts')!;
  const firstPrefix = `/api/reviews/${first.snapshot.id}`;
  assert.equal((await call(`${firstPrefix}/file-states`, 'PUT', { fileId: stable.id, fingerprint: fileFingerprint(stable), status: 'reviewed' })).status, 200);
  assert.equal((await call(`${firstPrefix}/file-states`, 'PUT', { fileId: changed.id, fingerprint: fileFingerprint(changed), status: 'reviewed' })).status, 200);
  const stableLine = first.gitlab!.files.find((item) => item.path === stable.path)!.addedLines[0];
  const changedLine = first.gitlab!.files.find((item) => item.path === changed.path)!.addedLines[0];
  for (const [path, line] of [[stable.path, stableLine], [changed.path, changedLine]] as const)
    assert.equal((await call(`${firstPrefix}/drafts`, 'POST', { path, side: 'after', line,
      body: '核对状态', evidence: '人工检查' })).status, 200);
  const updatedText = changed.after!.replace('state.pending = false;', 'state.pending = Boolean(value);');
  await writeFile(path.join(fixture.repo, changed.path), updatedText);
  await fixtureGit(fixture.repo, 'add', changed.path);
  await fixtureGit(fixture.repo, 'commit', '-m', 'Change pending behavior');
  headSha = await fixtureGit(fixture.repo, 'rev-parse', 'HEAD');
  versionId = 12;
  const secondResult = await call('/api/gitlab/import', 'POST', { ...input, previousReviewId: first.snapshot.id });
  assert.equal(secondResult.status, 200);
  const second = secondResult.body as SavedReview;
  const stableNext = second.snapshot.files.find((item) => item.path === stable.path)!;
  const changedNext = second.snapshot.files.find((item) => item.path === changed.path)!;
  assert.equal(second.incremental?.previousReviewId, first.snapshot.id);
  assert.equal(second.incremental?.files.find((item) => item.fileId === stableNext.id)?.status, 'unchanged');
  assert.equal(second.incremental?.files.find((item) => item.fileId === changedNext.id)?.status, 'modified');
  assert.equal(second.fileStates?.[stableNext.id]?.status, 'reviewed');
  assert.equal(second.fileStates?.[changedNext.id], undefined);
  assert.equal(second.commentDrafts?.find((item) => item.path === stable.path)?.anchorStatus, 'current');
  assert.equal(second.commentDrafts?.find((item) => item.path === changed.path)?.anchorStatus, 'pending');
  assert.equal((await call('/api/gitlab/import', 'POST', { ...input, previousReviewId: first.snapshot.id })).body.commentDrafts.length, 2);
  const secondPrefix = `/api/reviews/${second.snapshot.id}`;
  const pending = second.commentDrafts!.find((item) => item.path === changed.path)!;
  const newChangedLine = second.gitlab!.files.find((item) => item.path === changed.path)!.addedLines[0];
  assert.equal((await call(`${secondPrefix}/drafts/${pending.id}`, 'PUT', { path: changed.path, side: 'after',
    line: newChangedLine, scope: 'line', body: pending.body, evidence: pending.evidence })).status, 200);
  assert.equal((await store.get(second.snapshot.id)).commentDrafts?.find((item) => item.id === pending.id)?.anchorStatus, 'current');
  assert.equal((await call(`${secondPrefix}/drafts`, 'POST', { path: stable.path, side: 'after', line: 0,
    scope: 'file', category: 'detail', body: '文件说明', evidence: '人工检查' })).status, 200);
  const fileDraft = (await store.get(second.snapshot.id)).commentDrafts!.find((item) => item.scope === 'file')!;
  assert.equal((await call(`${secondPrefix}/drafts/${fileDraft.id}`, 'PUT', { path: stable.path, side: 'after',
    line: 0, scope: 'file', category: 'suggestion', suggestion: 'return value;', resolved: true,
    body: '修改建议', evidence: '人工检查' })).status, 200);
  const exported = await call(`${secondPrefix}/drafts/export`);
  assert.match(exported.body.markdown, /```suggestion\nreturn value;/);
  assert.match(exported.body.markdown, /已解决/);
  const lines = second.gitlab!.files.find((item) => item.path === stable.path)!.addedLines;
  assert.ok(lines.length >= 2);
  assert.equal((await call(`${secondPrefix}/drafts`, 'POST', { path: stable.path, side: 'after', line: lines[0],
    endLine: lines[1], scope: 'range', body: '范围', evidence: '人工检查' })).status, 200);
  assert.equal((await call(`${secondPrefix}/drafts`, 'POST', { path: stable.path, side: 'after', line: lines[0],
    endLine: 999, scope: 'range', body: '错误范围', evidence: '人工检查' })).status, 400);
  assert.equal((await store.get(first.snapshot.id)).commentDrafts?.length, 2);
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain'), '');
});
