import type { Change, GuideGroup, ReviewFile, Snapshot } from './types.js';

export interface FeatureFile {
  file: ReviewFile;
  changes: Change[];
}

// 功能清单只由已校验的变更 ID 回溯到固定快照，不依据文件名推断整文件归属。
export function featureFiles(snapshot: Snapshot, group: GuideGroup): FeatureFile[] {
  const selected = new Set(group.changeIds);
  return snapshot.files.flatMap((file) => {
    const changes = file.changes.filter((change) => selected.has(change.id));
    return changes.length ? [{ file, changes }] : [];
  });
}
