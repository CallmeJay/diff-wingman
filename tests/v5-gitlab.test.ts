import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { GitLabClient, changedLines } from '../src/server/gitlab.js';
import { ReviewStore } from '../src/server/store.js';
import type { SavedReview } from '../src/shared/types.js';
import { fixtureGit, makeFixture } from './fixture.js';

const mrUrl = 'https://gitlab.example.com/group/project/-/merge_requests/7';

test('GitLab diff 行号按新增/删除两侧记录，不把上下文行当成评论锚点', () => {
  assert.deepEqual(changedLines('@@ -3,3 +3,4 @@\n context\n-old\n+new\n+extra\n context\n'), {
    deletedLines: [4],
    addedLines: [4, 5],
  });
});

test('只读 MR 导入、草稿落盘和版本过期闭环；失败路径不写 GitLab 或仓库', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  await fixtureGit(
    fixture.repo,
    'remote',
    'add',
    'origin',
    'https://gitlab.example.com/group/project.git',
  );
  const storeDir = await mkdtemp(path.join(tmpdir(), 'review-v5-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const oldStatus = await fixtureGit(fixture.repo, 'status', '--porcelain');
  const patchFor = async (file: string) => {
    const raw = await fixtureGit(fixture.repo, 'diff', fixture.base, fixture.target, '--', file);
    return raw.slice(raw.indexOf('@@'));
  };
  const diffs = [
    { old_path: 'src/submit.ts', new_path: 'src/submit.ts', diff: await patchFor('src/submit.ts') },
    {
      old_path: 'src/submit.test.ts',
      new_path: 'src/submit.test.ts',
      diff: await patchFor('src/submit.test.ts'),
    },
  ];
  let version = 11;
  let collapsed = false;
  let wrongFile = false;
  let missingCommit = false;
  let changedAnchors = false;
  const methods: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    methods.push(init?.method ?? 'GET');
    const url = String(input);
    if (
      !url.startsWith('https://gitlab.example.com/api/v4/projects/group%2Fproject/merge_requests/7')
    )
      throw new Error(`unexpected URL: ${url}`);
    if (url.includes('/versions'))
      return Response.json([
        {
          id: version,
          base_commit_sha: fixture.base,
          head_commit_sha: missingCommit ? 'f'.repeat(40) : fixture.target,
          start_commit_sha: fixture.base,
        },
      ]);
    if (url.includes('/diffs'))
      return Response.json(
        diffs.map((item, index) =>
          index === 0 && collapsed
            ? { ...item, collapsed: true }
            : index === 0 && wrongFile
            ? { ...item, new_path: 'src/other.ts' }
            : index === 0 && changedAnchors
            ? { ...item, diff: `${item.diff}\n@@ -0,0 +999 @@\n+unexpected` }
            : item,
        ),
      );
    return Response.json({
      title: 'Restore pending state',
      diff_refs: {
        base_sha: fixture.base,
        head_sha: missingCommit ? 'f'.repeat(40) : fixture.target,
        start_sha: fixture.base,
      },
    });
  };
  const store = new ReviewStore(storeDir);
  const { app, stop } = createApp({
    store,
    gitlab: new GitLabClient(fakeFetch),
    provider: {
      async generate() {
        throw new Error('AI not needed');
      },
    },
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
  const input = {
    repo: fixture.repo,
    url: `${mrUrl}/diffs?view=parallel#note_1`,
    requirements: '失败后恢复状态',
  };
  assert.equal(
    (
      await call('/api/gitlab/import', 'POST', {
        ...input,
        url: 'https://other.example.com/group/project/-/merge_requests/7',
      })
    ).status,
    400,
  );
  assert.equal(methods.length, 0);
  collapsed = true;
  assert.equal((await call('/api/gitlab/import', 'POST', input)).status, 422);
  collapsed = false;
  wrongFile = true;
  assert.equal((await call('/api/gitlab/import', 'POST', input)).status, 409);
  wrongFile = false;
  missingCommit = true;
  assert.equal((await call('/api/gitlab/import', 'POST', input)).status, 409);
  missingCommit = false;
  assert.deepEqual(await store.list(), []);
  const created = await call('/api/gitlab/import', 'POST', input);
  assert.equal(created.status, 200);
  const review = created.body as SavedReview;
  assert.equal(review.gitlab?.url, mrUrl);
  assert.equal(review.gitlab?.versionId, 11);
  assert.equal(review.snapshot.base, fixture.base);
  assert.equal(review.snapshot.target, fixture.target);
  assert.equal(review.snapshot.files.length, 2);
  assert.equal((await call(`/api/reviews/${review.snapshot.id}/freshness`)).body.fresh, true);
  const anchor = review.gitlab!.files.find((file) => file.path === 'src/submit.ts')!;
  const line = anchor.addedLines[0];
  assert.ok(line > 0);
  const draftInput = {
    path: anchor.path,
    side: 'after',
    line,
    body: '失败后状态需要核对',
    evidence: '人工核对了 finally 分支',
  };
  assert.equal(
    (await call(`/api/reviews/${review.snapshot.id}/drafts`, 'POST', { ...draftInput, line: 999 }))
      .status,
    400,
  );
  assert.equal(
    (await call(`/api/reviews/${review.snapshot.id}/drafts`, 'POST', draftInput)).status,
    200,
  );
  const saved = await store.get(review.snapshot.id);
  assert.equal(saved.commentDrafts?.length, 1);
  assert.equal(saved.commentDrafts?.[0].line, line);
  assert.equal(saved.commentDrafts?.[0].oldPath, anchor.oldPath);
  const draftId = saved.commentDrafts![0].id;
  assert.equal(
    (
      await call(`/api/reviews/${review.snapshot.id}/drafts/${draftId}`, 'PUT', {
        body: '人工已复核的描述',
        evidence: '核对了失败后的状态',
      })
    ).status,
    200,
  );
  assert.equal((await store.get(review.snapshot.id)).commentDrafts?.[0].body, '人工已复核的描述');
  const importedAgain = await call('/api/gitlab/import', 'POST', input);
  assert.equal((importedAgain.body as SavedReview).snapshot.id, review.snapshot.id);
  assert.equal((importedAgain.body as SavedReview).commentDrafts?.length, 1);
  changedAnchors = true;
  assert.equal((await call('/api/gitlab/import', 'POST', input)).status, 409);
  changedAnchors = false;
  const report = await call(`/api/reviews/${review.snapshot.id}/drafts/export`);
  assert.match(report.body.markdown, /未向 GitLab 提交/);
  assert.match(report.body.markdown, /核对了失败后的状态/);
  version = 12;
  assert.equal((await call(`/api/reviews/${review.snapshot.id}/freshness`)).body.fresh, false);
  assert.equal(
    (await call(`/api/reviews/${review.snapshot.id}/drafts`, 'POST', draftInput)).status,
    409,
  );
  assert.equal(
    (
      await call(`/api/reviews/${review.snapshot.id}/drafts/${saved.commentDrafts![0].id}`, 'PUT', {
        body: '新描述',
        evidence: '新依据',
      })
    ).status,
    409,
  );
  const staleExport = await call(`/api/reviews/${review.snapshot.id}/drafts/export`);
  assert.match(staleExport.body.markdown, /所有草稿待重新定位/);
  assert.equal((await store.get(review.snapshot.id)).commentDrafts?.length, 1);
  assert.equal(
    (await call(`/api/reviews/${review.snapshot.id}/drafts/${draftId}`, 'DELETE')).status,
    200,
  );
  assert.equal((await store.get(review.snapshot.id)).commentDrafts?.length, 0);
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain'), oldStatus);
  assert.ok(methods.every((method) => method === 'GET'));
});
