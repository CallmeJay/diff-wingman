import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot, parseRawDiff } from '../src/server/git.js';
import { fixtureGit, makeFixture } from './fixture.js';

test('真实 Git 快照保持端点语义，忽略工作区并覆盖文件状态及特殊路径', async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  await writeFile(path.join(fixture.repo, 'src/submit.ts'), 'UNCOMMITTED WORKTREE CONTENT\n');
  await writeFile(path.join(fixture.repo, 'untracked.txt'), 'not in commits');
  const statusBefore = await fixtureGit(fixture.repo, 'status', '--porcelain=v1');
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  const statusAfter = await fixtureGit(fixture.repo, 'status', '--porcelain=v1');
  assert.equal(statusBefore, statusAfter);
  assert.equal(
    await readFile(path.join(fixture.repo, 'src/submit.ts'), 'utf8'),
    'UNCOMMITTED WORKTREE CONTENT\n',
  );
  const modified = snapshot.files.find((file) => file.path === 'src/submit.ts')!;
  assert.match(modified.before!, /const result = await request/);
  assert.match(modified.after!, /finally/);
  assert.equal(
    snapshot.files.some((file) => file.path === 'untracked.txt'),
    false,
  );
  assert.equal(snapshot.files.find((file) => file.path === 'obsolete.ts')?.status, 'D');
  const renamed = snapshot.files.find((file) => file.path === 'new label.txt')!;
  assert.equal(renamed.oldPath, 'old label.txt');
  assert.match(renamed.status, /^R/);
  assert.equal(renamed.changes.length, 1);
  assert.equal(snapshot.files.find((file) => file.path === 'notes:a\nb.md')?.after, 'after\n');
  assert.match(snapshot.files.find((file) => file.path === 'binary.bin')!.issue!, /二进制/);
  assert.match(snapshot.files.find((file) => file.path === 'large.txt')!.issue!, /超过/);
  assert.match(snapshot.files.find((file) => file.path === 'outside-link')!.issue!, /符号链接/);
  assert.ok(
    snapshot.refs.some((ref) => ref.path === 'src/transport.ts' && ref.role === 'dependency'),
  );
  assert.ok(snapshot.refs.some((ref) => ref.path === 'src/panel.ts' && ref.role === 'candidate'));
  assert.ok(
    snapshot.refs.some(
      (ref) => ref.path === 'src/panel.ts' && /显式导入并调用 submit/.test(ref.label),
    ),
  );
  for (const ref of snapshot.refs) {
    const full = await fixtureGit(fixture.repo, 'show', ref.blobOid);
    const expected = full
      .split('\n')
      .slice(ref.startLine - 1, ref.endLine)
      .join('\n');
    assert.equal(ref.code.trimEnd(), expected.trimEnd());
  }
  const same = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  assert.equal(same.id, snapshot.id);
  const reversed = await createSnapshot(fixture.repo, fixture.target, fixture.base);
  assert.notEqual(reversed.id, snapshot.id);
  assert.match(reversed.files.find((file) => file.path === 'src/submit.ts')!.before!, /finally/);
});

test('无变更与错误版本不产生伪造 diff', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const snapshot = await createSnapshot(fixture.repo, 'HEAD', 'HEAD');
  assert.deepEqual(snapshot.files, []);
  await assert.rejects(createSnapshot(fixture.repo, '--help', 'HEAD'));
  await assert.rejects(createSnapshot(fixture.repo, 'missing-ref', 'HEAD'));
});

test('原始列表按 NUL 解析，拒绝不完整重命名记录', () => {
  const oid = 'a'.repeat(40);
  const result = parseRawDiff(
    `:100644 100644 ${oid} ${oid} R100\0name with space\0name\nwith newline\0`,
  );
  assert.equal(result[0].path, 'name\nwith newline');
  assert.throws(() => parseRawDiff(`:100644 100644 ${oid} ${oid} R100\0old\0`));
});
