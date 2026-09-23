import { structuredPatch } from 'diff';
import type {
  Change, CommentDraft, IncrementalComparison, IncrementalFile, LocalComment,
  ReviewFile, SavedReview,
} from './types.js';
import { fileFingerprint } from './review-core.js';

const hunksOf = (file: ReviewFile) => file.changes.filter((change) => change.id.includes(':hunk-'));
const contentKey = (file: ReviewFile) => JSON.stringify([
  file.oldMode, file.newMode, file.oldOid, file.newOid,
]);
const patchCache = new WeakMap<ReviewFile, ReturnType<typeof structuredPatch>['hunks']>();

// 同一固定文件的补丁只解析一次，逐块状态和评论定位共用结果。
function patchHunks(file: ReviewFile): ReturnType<typeof structuredPatch>['hunks'] {
  const cached = patchCache.get(file);
  if (cached) return cached;
  const hunks = file.before === null || file.after === null ? [] :
    structuredPatch(file.oldPath, file.path, file.before, file.after, '', '', { context: 3 }).hunks;
  patchCache.set(file, hunks);
  return hunks;
}

// 位置和上下文会随 rebase 改变；只用原样增删行建立 hunk 身份，重复内容须留待人工判断。
export function hunkFingerprint(file: ReviewFile, change: Change): string {
  if (file.before === null || file.after === null) return '';
  const index = hunksOf(file).findIndex((item) => item.id === change.id);
  if (index < 0) return '';
  const hunk = patchHunks(file)[index];
  return hunk ? JSON.stringify(hunk.lines.filter((line) => /^[+-\\]/.test(line))) : '';
}

function changedPositions(file: ReviewFile, change: Change, side: 'before' | 'after'): number[] {
  if (file.before === null || file.after === null) return [];
  const index = hunksOf(file).findIndex((item) => item.id === change.id);
  const hunk = patchHunks(file)[index];
  if (!hunk) return [];
  const result: number[] = [];
  let before = hunk.oldStart;
  let after = hunk.newStart;
  for (const row of hunk.lines) {
    if (row.startsWith('-')) { if (side === 'before') result.push(before); before++; }
    else if (row.startsWith('+')) { if (side === 'after') result.push(after); after++; }
    else if (row.startsWith(' ')) { before++; after++; }
  }
  return result;
}

export function compareMrVersions(previous: SavedReview, current: SavedReview): IncrementalComparison {
  if (!previous.gitlab || !current.gitlab) throw new Error('仅支持同一 GitLab MR 的版本比较。');
  // 先按路径，再按两侧内容寻找唯一文件；不唯一时不迁移人工结论。
  const oldFiles = previous.snapshot.files;
  const newFiles = current.snapshot.files;
  const used = new Set<string>();
  const ambiguousOld = new Set<string>();
  const files: IncrementalFile[] = [];
  for (const file of newFiles) {
    const available = oldFiles.filter((old) => !used.has(old.id));
    let candidates = available.filter((old) => old.path === file.path);
    let matchReason = '路径相同';
    if (!candidates.length) {
      candidates = available.filter((old) => old.path === file.oldPath || old.oldPath === file.path);
      matchReason = '路径移动';
    }
    if (!candidates.length) {
      candidates = available.filter((old) => contentKey(old) === contentKey(file));
      matchReason = '路径变化但两侧内容相同';
    }
    const duplicateDestination = candidates.length === 1 && matchReason !== '路径相同' &&
      newFiles.filter((other) => other.path !== file.path && (
        matchReason === '路径移动'
          ? other.oldPath === candidates[0].path || other.path === candidates[0].oldPath
          : contentKey(other) === contentKey(file)
      )).length > 0;
    if (candidates.length > 1 || duplicateDestination) {
      for (const candidate of candidates) ambiguousOld.add(candidate.id);
      files.push({ fileId: file.id, path: file.path, status: 'ambiguous',
        reason: '旧版有多个可能对应的文件，未自动继承', hunks: [], removedHunks: [] });
      continue;
    }
    const old = candidates[0];
    if (!old) {
      files.push({ fileId: file.id, path: file.path, status: 'new', reason: '本轮新增变更文件',
        hunks: hunksOf(file).map((change) => ({ changeId: change.id,
          status: 'new', reason: '本轮新增变更块' })), removedHunks: [] });
      continue;
    }
    used.add(old.id);
    const oldHunks = hunksOf(old).map((change) => ({ change, fingerprint: hunkFingerprint(old, change) }));
    const newHunks = hunksOf(file).map((change) => ({ change, fingerprint: hunkFingerprint(file, change) }));
    const hunks = newHunks.map(({ change, fingerprint }) => {
      const oldMatches = oldHunks.filter((item) => fingerprint && item.fingerprint === fingerprint);
      const newMatches = newHunks.filter((item) => fingerprint && item.fingerprint === fingerprint);
      if (oldMatches.length > 1 || newMatches.length > 1)
        return { changeId: change.id, status: 'ambiguous' as const,
          reason: '相同变更内容出现多次，未自动继承' };
      if (oldMatches.length === 1 && newMatches.length === 1)
        return { changeId: change.id, status: 'unchanged' as const,
          previousChangeId: oldMatches[0].change.id,
          reason: oldMatches[0].change.oldStart === change.oldStart && oldMatches[0].change.newStart === change.newStart
            ? '增删内容完全一致' : '行号或上下文变化，增删内容完全一致' };
      return { changeId: change.id, status: 'new' as const,
        reason: '增删内容与旧版不同，需复审' };
    });
    const matched = new Set(hunks.map((hunk) => hunk.previousChangeId).filter(Boolean));
    const removedHunks = oldHunks.filter((item) => !matched.has(item.change.id))
      .map((item) => ({ changeId: item.change.id, label: item.change.label }));
    const unchanged = contentKey(old) === contentKey(file);
    files.push({ fileId: file.id, previousFileId: old.id, path: file.path,
      status: unchanged ? 'unchanged' : 'modified',
      reason: unchanged ? `${matchReason}，两侧内容和模式完全一致` : `${matchReason}，文件内容有变化`,
      hunks, removedHunks });
  }
  for (const old of oldFiles) if (!used.has(old.id)) {
    const ambiguous = ambiguousOld.has(old.id);
    files.push({ previousFileId: old.id, path: old.path,
      status: ambiguous ? 'ambiguous' : 'removed',
      reason: ambiguous ? '可能与路径变化的文件对应，待确认' : '此变更已从最新 MR diff 移除',
      hunks: [], removedHunks: hunksOf(old).map((change) => ({ changeId: change.id, label: change.label })) });
  }
  return {
    previousReviewId: previous.snapshot.id,
    previousVersionId: previous.gitlab.versionId,
    currentVersionId: current.gitlab.versionId,
    origin: previous.gitlab.baseSha === current.gitlab.baseSha &&
        previous.gitlab.headSha !== current.gitlab.headSha
      ? 'source-update'
      : previous.gitlab.headSha === current.gitlab.headSha &&
          previous.gitlab.baseSha !== current.gitlab.baseSha ? 'base-update' : 'uncertain',
    files,
  };
}

function mappedLine(
  oldFile: ReviewFile, newFile: ReviewFile, comparison: IncrementalFile,
  side: 'before' | 'after', line: number, endLine: number,
): number | null {
  if (comparison.status === 'unchanged') return line;
  // 文件部分变化时，只迁移原变更行在唯一不变 hunk 中的连续区间。
  const oldHunk = hunksOf(oldFile).find((change) => {
    const start = side === 'before' ? change.oldStart : change.newStart;
    const count = side === 'before' ? change.oldLines : change.newLines;
    return count > 0 && line >= start && endLine < start + count;
  });
  const mapping = comparison.hunks.find((hunk) => hunk.previousChangeId === oldHunk?.id && hunk.status === 'unchanged');
  const newHunk = hunksOf(newFile).find((change) => change.id === mapping?.changeId);
  if (!oldHunk || !newHunk) return null;
  const oldChanged = changedPositions(oldFile, oldHunk, side);
  const newChanged = changedPositions(newFile, newHunk, side);
  const index = oldChanged.indexOf(line);
  if (index < 0 || !oldChanged.slice(index, index + endLine - line + 1).every((position, offset) => position === line + offset) ||
      !newChanged.slice(index, index + endLine - line + 1).every((position, offset) => position === newChanged[index] + offset) ||
      oldChanged[index + endLine - line] !== endLine || newChanged[index + endLine - line] === undefined)
    return null;
  const newLine = newChanged[index];
  const oldSource = (side === 'before' ? oldFile.before : oldFile.after)?.split('\n').slice(line - 1, endLine);
  const newSource = (side === 'before' ? newFile.before : newFile.after)?.split('\n').slice(newLine - 1, newLine + endLine - line);
  return JSON.stringify(oldSource) === JSON.stringify(newSource) ? newLine : null;
}

// 旧记录保留在原快照；新快照仅复制可唯一对应的状态，无法定位的评论显式待处理。
export function inheritMrReview(previous: SavedReview, current: SavedReview, comparison: IncrementalComparison): void {
  const oldFiles = new Map(previous.snapshot.files.map((file) => [file.id, file]));
  const newFiles = new Map(current.snapshot.files.map((file) => [file.id, file]));
  current.fileStates ??= {};
  current.hunkStates ??= {};
  current.commentDrafts ??= [];
  current.localComments ??= [];
  for (const item of comparison.files) {
    const oldFile = item.previousFileId && oldFiles.get(item.previousFileId);
    const newFile = item.fileId && newFiles.get(item.fileId);
    if (!oldFile || !newFile || item.status === 'ambiguous') continue;
    const oldState = previous.fileStates?.[oldFile.id];
    if (item.status === 'unchanged' && oldState?.fingerprint === fileFingerprint(oldFile) && !current.fileStates[newFile.id])
      current.fileStates[newFile.id] = { ...oldState, fingerprint: fileFingerprint(newFile) };
    for (const hunk of item.hunks) {
      const old = hunk.previousChangeId ? previous.hunkStates?.[hunk.previousChangeId] : undefined;
      const change = newFile.changes.find((candidate) => candidate.id === hunk.changeId);
      if (hunk.status === 'unchanged' && change && old?.fingerprint === hunkFingerprint(newFile, change) && !current.hunkStates[hunk.changeId])
        current.hunkStates[hunk.changeId] = { ...old, inheritedFrom: previous.snapshot.id };
    }
  }
  const locate = (comment: CommentDraft | LocalComment) => {
    const oldFile = 'fileId' in comment
      ? oldFiles.get(comment.fileId) : previous.snapshot.files.find((file) => file.path === comment.path);
    const item = comparison.files.find((row) => row.previousFileId === oldFile?.id && row.fileId);
    const newFile = item?.fileId && newFiles.get(item.fileId);
    if (!oldFile || !item || !newFile || item.status === 'ambiguous')
      return { newFile: null, line: null, reason: '旧文件无法唯一对应最新 MR diff' };
    if (comment.scope === 'file')
      return item.status === 'unchanged'
        ? { newFile, line: 0, reason: item.reason }
        : { newFile, line: null, reason: '文件内容已改变，请重新核对文件级评论' };
    const line = mappedLine(oldFile, newFile, item, comment.side, comment.line, comment.endLine ?? comment.line);
    if (line !== null && 'versionId' in comment) {
      const remote = current.gitlab?.files.find((file) => file.path === newFile.path);
      const changed = new Set(comment.side === 'after' ? remote?.addedLines : remote?.deletedLines);
      for (let number = line; number <= line + (comment.endLine ?? comment.line) - comment.line; number++)
        if (!changed.has(number))
          return { newFile, line: null, reason: '最新 GitLab diff 中没有可验证的评论行，待重新定位' };
    }
    return { newFile, line, reason: line === null ? '原变更块已改变或无法唯一匹配，请重新定位' : '原变更块完全不变且唯一匹配' };
  };
  for (const old of previous.commentDrafts ?? []) {
    if (current.commentDrafts.some((item) => item.inheritedFrom === old.id)) continue;
    const { newFile, line, reason } = locate(old);
    const offset = line === null ? 0 : line - old.line;
    current.commentDrafts.push({ ...old, id: crypto.randomUUID(), inheritedFrom: old.id,
      path: newFile?.path ?? old.path, oldPath: newFile?.oldPath ?? old.oldPath,
      line: line ?? old.line, endLine: old.endLine === undefined ? undefined : old.endLine + offset,
      versionId: current.gitlab!.versionId, anchorStatus: line === null ? 'pending' : 'current',
      anchorReason: reason });
  }
  for (const old of previous.localComments ?? []) {
    if (current.localComments.some((item) => item.inheritedFrom === old.id)) continue;
    const { newFile, line, reason } = locate(old);
    const offset = line === null ? 0 : line - old.line;
    current.localComments.push({ ...old, id: crypto.randomUUID(), inheritedFrom: old.id,
      fileId: newFile?.id ?? old.fileId, path: newFile?.path ?? old.path,
      fingerprint: newFile ? fileFingerprint(newFile) : old.fingerprint,
      line: line ?? old.line, endLine: old.endLine === undefined ? undefined : old.endLine + offset,
      anchorStatus: line === null ? 'pending' : 'current', anchorReason: reason });
  }
  current.incremental = comparison;
}
