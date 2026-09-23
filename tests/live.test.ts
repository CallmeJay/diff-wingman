import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createLiveSnapshot, listUntracked } from '../src/server/git.js';
import { fixtureGit, makeFixture } from './fixture.js';

test('暂存区与工作区分别冻结所选内容，不修改仓库', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const filePath = path.join(fixture.repo, 'src/submit.ts');
  const original = await readFile(filePath, 'utf8');
  await writeFile(filePath, `// staged\n${original}`);
  await fixtureGit(fixture.repo, 'add', 'src/submit.ts');
  await writeFile(filePath, `// working\n// staged\n${original}`);
  await writeFile(path.join(fixture.repo, 'new-file.ts'), 'export const newValue = 1;\n');
  await symlink('/etc/hosts', path.join(fixture.repo, 'new-link'));
  const before = await fixtureGit(fixture.repo, 'status', '--porcelain=v1');

  const stage = await createLiveSnapshot(fixture.repo, 'staged');
  assert.match(stage.files[0].after!, /^\/\/ staged/);
  assert.doesNotMatch(stage.files[0].after!, /working/);
  assert.equal(
    stage.files.some((file) => file.path === 'new-file.ts'),
    false,
  );
  assert.equal(stage.mode, 'staged');
  const available = await listUntracked(fixture.repo);
  assert.ok(available.includes('new-file.ts'));
  assert.ok(available.includes('new-link'));

  const work = await createLiveSnapshot(fixture.repo, 'working', ['new-file.ts', 'new-link']);
  assert.match(work.files.find((file) => file.path === 'src/submit.ts')!.after!, /^\/\/ working/);
  assert.equal(
    work.files.find((file) => file.path === 'new-file.ts')!.after,
    'export const newValue = 1;\n',
  );
  assert.match(work.files.find((file) => file.path === 'new-link')!.issue!, /符号链接/);
  assert.ok(work.refs.some((ref) => ref.blobOid.startsWith('worktree:')));
  assert.notEqual(work.id, stage.id);
  assert.equal(await fixtureGit(fixture.repo, 'status', '--porcelain=v1'), before);

  const same = await createLiveSnapshot(fixture.repo, 'working', ['new-file.ts', 'new-link']);
  assert.equal(same.id, work.id);
  await writeFile(filePath, `// changed again\n${original}`);
  const changed = await createLiveSnapshot(fixture.repo, 'working', ['new-file.ts', 'new-link']);
  assert.notEqual(changed.id, work.id);
  await assert.rejects(
    createLiveSnapshot(fixture.repo, 'working', ['not-listed.ts']),
    /所选未跟踪文件/,
  );
});
