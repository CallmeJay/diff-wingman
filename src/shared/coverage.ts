import type { Change, CommentDraft, LocalComment, ReviewFile, SavedReview, VerificationRecord } from './types.js';
import { listClaims } from './claims.js';
import { hunkFingerprint } from './incremental.js';

export interface HunkCoverageRow {
  change: Change;
  file: ReviewFile;
  requirementIds: string[];
  analysis: 'not_generated' | 'explained' | 'pending' | 'unreviewed';
  analysisReason: string;
  reviewStatus: 'unread' | 'in_progress' | 'question' | 'reviewed';
  understandingStatus: 'unread' | 'understood' | 'question' | 'verified' | 'stale';
  comments: number;
  unresolvedComments: number;
  fileComments: number;
  verifications: VerificationRecord[];
}

function overlaps(comment: CommentDraft | LocalComment, change: Change): boolean {
  if (comment.anchorStatus === 'pending' || comment.scope === 'file') return false;
  const start = comment.side === 'before' ? change.oldStart : change.newStart;
  const count = comment.side === 'before' ? change.oldLines : change.newLines;
  return count > 0 && comment.line < start + count && (comment.endLine ?? comment.line) >= start;
}

// 矩阵只从当前快照的原始记录推导；旧导读、旧确认和旧运行记录显式失效。
export function hunkCoverage(review: SavedReview): HunkCoverageRow[] {
  const { snapshot, guide } = review;
  const claims = guide ? listClaims(guide) : [];
  const unreviewed = new Map(guide?.unreviewed.map((item) => [item.changeId, item.reason]) ?? []);
  const grouped = new Set(guide?.groups.flatMap((group) => group.changeIds) ?? []);
  return snapshot.files.flatMap((file) => file.changes.map((change) => {
    const explanation = review.hunkExplanations?.[change.id];
    const currentExplanation = explanation?.guideFingerprint === review.guideFingerprint ? explanation : undefined;
    const state = review.hunkUnderstandingStates?.[change.id];
    const understandingStatus = !state ? 'unread' :
      !currentExplanation || state.guideFingerprint !== review.guideFingerprint ||
      state.explanationFingerprint !== currentExplanation.fingerprint ? 'stale' : state.status;
    const direct = [
      ...(review.commentDrafts ?? []).filter((item) => item.path === file.path && overlaps(item, change)),
      ...(review.localComments ?? []).filter((item) => item.fileId === file.id && item.path === file.path && overlaps(item, change)),
    ];
    const fileComments = [
      ...(review.commentDrafts ?? []).filter((item) => item.path === file.path && item.scope === 'file'),
      ...(review.localComments ?? []).filter((item) => item.fileId === file.id && item.path === file.path && item.scope === 'file'),
    ];
    const relatedClaims = new Set(claims.filter((claim) => claim.changeIds.includes(change.id)).map((claim) => `claim:${claim.key}`));
    const relatedGroups = new Set(guide?.groups.flatMap((group, index) =>
      group.changeIds.includes(change.id) ? group.questions.map((_question, questionIndex) =>
        `question:${index}:${questionIndex}`) : []) ?? []);
    const verifications = (review.verificationRecords ?? []).filter((record) =>
      record.snapshotId === snapshot.id && record.guideFingerprint === review.guideFingerprint &&
      (relatedClaims.has(record.caseId) || relatedGroups.has(record.caseId)));
    const reviewState = review.hunkStates?.[change.id];
    const analysis = unreviewed.has(change.id) ? 'unreviewed' : !currentExplanation ? 'not_generated' :
      [currentExplanation.what, currentExplanation.before, currentExplanation.after].some((item) => item.basis === 'pending') ||
      currentExplanation.pending.length > 0 ? 'pending' : 'explained';
    return { change, file, requirementIds: guide?.requirementLinks?.filter((link) => link.changeIds.includes(change.id))
      .map((link) => link.requirementId) ?? [],
      analysis, analysisReason: unreviewed.get(change.id) ??
        (!currentExplanation && grouped.has(change.id) ? '阅读路线已有分组，但没有当前逐块解释' : ''),
      reviewStatus: reviewState?.fingerprint === hunkFingerprint(file, change) ? reviewState.status : 'unread', understandingStatus,
      comments: direct.length, unresolvedComments: direct.filter((item) => !item.resolved).length,
      fileComments: fileComments.length, verifications };
  }));
}
