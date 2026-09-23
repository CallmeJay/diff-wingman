import type { ReviewFile } from './types.js';

// 人工记录以当前文件的路径、模式和两侧内容身份为边界，不按可重复的 file-1 编号跨快照继承。
export function fileFingerprint(file: ReviewFile): string {
  return JSON.stringify([
    file.status,
    file.oldPath,
    file.path,
    file.oldMode,
    file.newMode,
    file.oldOid,
    file.newOid,
  ]);
}

export function sourceLineCount(source: string): number {
  if (!source) return 0;
  const lines = source.split('\n');
  return lines.length - Number(lines.at(-1) === '');
}
