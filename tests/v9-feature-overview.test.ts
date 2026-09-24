import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot, readCommitContext } from '../src/server/git.js';
import { buildPrompt } from '../src/server/guide.js';
import { featureFiles } from '../src/shared/feature-overview.js';
import type { GuideGroup } from '../src/shared/types.js';
import { fixtureGit, makeFixture } from './fixture.js';

test('固定提交范围只把可对应的 commit subject 作为导读线索', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  const context = await readCommitContext(snapshot);
  assert.deepEqual(context.messages.map((item) => item.subject), ['Restore pending state after failed requests']);
  assert.doesNotMatch(buildPrompt(snapshot, context), /Add initial fixture/);
  assert.match(buildPrompt(snapshot, context), /作者意图线索/);
  const reversed = await createSnapshot(fixture.repo, fixture.target, fixture.base);
  assert.deepEqual((await readCommitContext(reversed)).messages, []);
  assert.match((await readCommitContext(reversed)).note!, /祖先/);
  assert.deepEqual((await readCommitContext({ ...snapshot, mode: 'working' })).messages, []);
});

test('同一文件的两个功能只映射各自 Git hunk，且覆盖全部变更', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const filePath = path.join(fixture.repo, 'src/features.ts');
  const lines = Array.from({ length: 40 }, (_, index) => `export const value${index} = ${index};`);
  await writeFile(filePath, `${lines.join('\n')}\n`);
  await fixtureGit(fixture.repo, 'add', '.');
  await fixtureGit(fixture.repo, 'commit', '-m', 'Add feature baseline');
  const base = await fixtureGit(fixture.repo, 'rev-parse', 'HEAD');
  lines[2] = 'export const value2 = 200;';
  lines[35] = 'export const value35 = 3500;';
  await writeFile(filePath, `${lines.join('\n')}\n`);
  await fixtureGit(fixture.repo, 'add', '.');
  await fixtureGit(fixture.repo, 'commit', '-m', 'Update two features');
  const snapshot = await createSnapshot(fixture.repo, base, 'HEAD');
  const file = snapshot.files.find((item) => item.path === 'src/features.ts')!;
  assert.equal(file.changes.length, 2);
  const group = (index: number): GuideGroup => ({
    title: `功能 ${index + 1}`,
    changeIds: [file.changes[index].id],
    before: { text: '修改前', basis: 'inference', refIds: [] },
    after: { text: '修改后', basis: 'inference', refIds: [] },
    notes: [],
    questions: [],
  });
  const first = featureFiles(snapshot, group(0));
  const second = featureFiles(snapshot, group(1));
  assert.equal(first[0].file.path, second[0].file.path);
  assert.deepEqual(first[0].changes.map((item) => item.id), [file.changes[0].id]);
  assert.deepEqual(second[0].changes.map((item) => item.id), [file.changes[1].id]);
  assert.equal(first[0].changes[0].newStart < second[0].changes[0].newStart, true);
  assert.equal(first[0].changes.length + second[0].changes.length, file.changes.length);
});
