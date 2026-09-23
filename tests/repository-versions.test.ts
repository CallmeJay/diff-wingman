import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { AppError } from '../src/server/errors.js';
import { createSnapshot, listRepositoryVersions } from '../src/server/git.js';
import { ReviewStore } from '../src/server/store.js';
import { fixtureGit, makeFixture } from './fixture.js';

test('仓库版本只列出可比较的本地引用，选择后仍按现有快照语义解析', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  await fixtureGit(fixture.repo, 'branch', 'baseline', fixture.base);
  await fixtureGit(fixture.repo, 'update-ref', 'refs/remotes/origin/main', fixture.target);
  await fixtureGit(fixture.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await fixtureGit(fixture.repo, 'tag', '-a', 'v2', '-m', 'Version two', fixture.target);
  const blob = await fixtureGit(fixture.repo, 'rev-parse', 'HEAD:src/submit.ts');
  await fixtureGit(fixture.repo, 'tag', 'blob-marker', blob);
  const before = await fixtureGit(fixture.repo, 'status', '--porcelain=v1');

  const options = await listRepositoryVersions(path.join(fixture.repo, 'src'));
  assert.deepEqual(options.map(({ value }) => value), [
    'HEAD',
    'refs/heads/baseline',
    'refs/heads/main',
    'refs/remotes/origin/main',
    'refs/tags/v2',
  ]);
  assert.deepEqual(options.map(({ label }) => label), [
    '当前 HEAD',
    '本地分支 · baseline',
    '本地分支 · main',
    '远端分支 · origin/main',
    '标签 · v2',
  ]);
  const snapshot = await createSnapshot(fixture.repo, options[1].value, options[4].value);
  assert.equal(snapshot.base, fixture.base);
  assert.equal(snapshot.target, fixture.target);
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain=v1'), before);
});

test('空仓库没有不可解析的 HEAD，非仓库路径明确报错', async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), 'review-versions-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(
    listRepositoryVersions(empty),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 400 &&
      error.message === '所填路径不是可读取的 Git 仓库。',
  );
  await fixtureGit(empty, 'init', '-b', 'main');
  assert.deepEqual(await listRepositoryVersions(empty), []);
});

test('版本接口受本机会话保护，返回选中仓库的实际引用', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-versions-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { app, stop } = createApp({ store: new ReviewStore(directory) });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    stop();
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = (await fetch(`${origin}/api/bootstrap`).then((response) => response.json())) as {
    token: string;
  };
  const request = (body: unknown, authenticated = true) =>
    fetch(`${origin}/api/repository/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { 'X-Review-Token': token } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal((await request({ repo: fixture.repo }, false)).status, 403);
  assert.equal((await request({ repo: '' })).status, 400);
  const response = await request({ repo: fixture.repo });
  assert.equal(response.status, 200);
  const versions = (await response.json()) as { value: string }[];
  assert.deepEqual(versions.map(({ value }) => value), ['HEAD', 'refs/heads/main']);
});
