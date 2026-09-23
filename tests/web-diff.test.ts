import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiffBlocks } from '../src/web/diff-lines.js';

test('关闭空白变更时不高亮纯空白差异，仍保留两侧原始源码', () => {
  const before = 'const value = 1;\n  return value;\n';
  const after = 'const  value=1;\n\treturn value;\n';
  const shown = buildDiffBlocks(before, after, true);
  const hidden = buildDiffBlocks(before, after, false);
  assert.ok(shown.some((block) => block.changed));
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].changed, false);
  assert.deepEqual(hidden[0].before.map((line) => line.text), ['const value = 1;', '  return value;']);
  assert.deepEqual(hidden[0].after.map((line) => line.text), ['const  value=1;', '\treturn value;']);
});

test('忽略空白后仍标出代码变更并保持两侧真实行号', () => {
  const blocks = buildDiffBlocks('a\n  keep\nold\n', 'a\n\tkeep\nnew\nextra\n', false);
  assert.deepEqual(blocks.map((block) => block.changed), [false, true]);
  assert.deepEqual(blocks[1].before, [{ number: 3, text: 'old' }]);
  assert.deepEqual(blocks[1].after, [
    { number: 3, text: 'new' },
    { number: 4, text: 'extra' },
  ]);
});

test('空文件与末尾换行不产生虚假的空白行', () => {
  assert.deepEqual(buildDiffBlocks('', '', true), []);
  assert.deepEqual(buildDiffBlocks('', 'new\n', true)[0].after, [{ number: 1, text: 'new' }]);
  assert.equal(buildDiffBlocks('old\r\n', 'old\n', true)[0].changed, true);
  assert.equal(buildDiffBlocks('old\r\n', 'old\n', false)[0].changed, false);
});
