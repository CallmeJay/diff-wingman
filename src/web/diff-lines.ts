import { diffArrays } from 'diff';

export type DiffLine = { number: number; text: string };
export type DiffBlock = { before: DiffLine[]; after: DiffLine[]; changed: boolean };

function sourceLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function buildDiffBlocks(before: string, after: string, showWhitespaceChanges: boolean): DiffBlock[] {
  const oldLines = sourceLines(before);
  const newLines = sourceLines(after);
  // 关闭空白变更时，按 Git -w 的行比较语义忽略行内空白，但展示的仍是原始源码。
  const changes = diffArrays(oldLines, newLines, {
    comparator: showWhitespaceChanges
      ? undefined
      : (left, right) => left.replace(/\s+/g, '') === right.replace(/\s+/g, ''),
  });
  const result: DiffBlock[] = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  let pendingBefore: DiffLine[] = [];
  let pendingAfter: DiffLine[] = [];
  const flush = () => {
    if (pendingBefore.length || pendingAfter.length) {
      result.push({ before: pendingBefore, after: pendingAfter, changed: true });
      pendingBefore = [];
      pendingAfter = [];
    }
  };
  for (const change of changes) {
    const count = change.value.length;
    if (change.removed) {
      pendingBefore.push(...oldLines.slice(beforeNumber - 1, beforeNumber - 1 + count).map((text) => ({ number: beforeNumber++, text })));
    } else if (change.added) {
      pendingAfter.push(...newLines.slice(afterNumber - 1, afterNumber - 1 + count).map((text) => ({ number: afterNumber++, text })));
    } else {
      flush();
      if (count === 0) continue;
      result.push({
        before: oldLines.slice(beforeNumber - 1, beforeNumber - 1 + count).map((text) => ({ number: beforeNumber++, text })),
        after: newLines.slice(afterNumber - 1, afterNumber - 1 + count).map((text) => ({ number: afterNumber++, text })),
        changed: false,
      });
    }
  }
  flush();
  return result;
}
