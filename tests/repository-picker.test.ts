import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { AppError } from '../src/server/errors.js';
import { pickRepository } from '../src/server/folder-picker.js';
import { ReviewStore } from '../src/server/store.js';
import { makeFixture } from './fixture.js';

test('系统所选目录：Git 子目录回填根路径，取消不选中路径，无效目录报错', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const outside = await mkdtemp(path.join(tmpdir(), 'review-picker-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));

  assert.equal(await pickRepository(async () => path.join(fixture.repo, 'src')), await realpath(fixture.repo));
  assert.equal(await pickRepository(async () => null), null);
  await assert.rejects(
    pickRepository(async () => outside),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 400 &&
      error.message === '所选文件夹不是可读取的 Git 仓库。',
  );
});

test('目录选择接口仅接受本机会话请求，并区分选中与取消', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-picker-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let selected: string | null = fixture.repo;
  const { app, stop } = createApp({
    store: new ReviewStore(directory),
    repositoryPicker: async () => selected,
  });
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    stop();
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = (await fetch(`${origin}/api/bootstrap`).then((response) =>
    response.json(),
  )) as { token: string };
  assert.equal((await fetch(`${origin}/api/repository/pick`, { method: 'POST' })).status, 403);
  const call = async () => {
    const response = await fetch(`${origin}/api/repository/pick`, {
      method: 'POST',
      headers: { 'X-Review-Token': token },
    });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await call(), { status: 200, body: { repo: fixture.repo } });
  selected = null;
  assert.deepEqual(await call(), { status: 200, body: { cancelled: true } });
});
