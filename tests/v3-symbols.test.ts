import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSnapshot } from '../src/server/git.js';
import { findStaticReferences } from '../src/server/symbols.js';
import { ReviewStore } from '../src/server/store.js';
import { makeFixture } from './fixture.js';

test('静态符号定位区分别名引用和无关同名函数', () => {
  const sources = new Map([
    ['src/submit.ts', 'export function submit(value: string) { return value; }\n'],
    [
      'src/panel.ts',
      "import { submit as send } from './submit';\nexport const click = () => send('x');\n",
    ],
    ['src/other.ts', 'export function submit(value: string) { return value; }\n'],
    ['src/decoy.ts', 'export const click = () => submit(1);\n'],
  ]);
  const references = findStaticReferences(sources, [
    { path: 'src/submit.ts', name: 'submit', startLine: 1, endLine: 1, changeIds: ['change-1'] },
  ]);
  assert.deepEqual(references, [
    { path: 'src/panel.ts', line: 2, symbol: 'submit', changeIds: ['change-1'] },
  ]);
});

test('真实 Git 快照将静态引用绑定到变更，且不修改被审查仓库', async (t) => {
  const fixture = await makeFixture(false);
  t.after(fixture.cleanup);
  const snapshot = await createSnapshot(fixture.repo, fixture.base, fixture.target);
  const changeIds = snapshot.files
    .find((file) => file.path === 'src/submit.ts')!
    .changes.map((change) => change.id);
  const reference = snapshot.refs.find(
    (ref) => ref.role === 'reference' && ref.path === 'src/panel.ts' && ref.side === 'after',
  );
  assert.ok(reference, `静态引用缺失：${snapshot.gaps.join('；')}`);
  assert.ok(reference.relatedChangeIds?.some((id) => changeIds.includes(id)));
  assert.match(reference.label, /静态引用.*运行时待核对/);
  assert.match(reference.code, /submit\(/);
  assert.equal(reference.startLine, reference.endLine);
  const directory = await mkdtemp(path.join(tmpdir(), 'review-v3-merge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ReviewStore(directory);
  const legacyRefs = snapshot.refs
    .filter((ref) => ref.role !== 'reference')
    .map((ref, index) => ({ ...ref, id: `ref-${index + 1}` }));
  await store.create({
    ...snapshot,
    refs: legacyRefs,
  });
  await store.update(snapshot.id, (review) => {
    review.notes.overview = '旧版人工笔记';
  });
  const enriched = await store.create(snapshot);
  assert.ok(enriched.snapshot.refs.some((ref) => ref.id === reference.id));
  assert.equal(enriched.notes.overview, '旧版人工笔记');
});
