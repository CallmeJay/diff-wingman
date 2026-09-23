export type Side = 'before' | 'after';
export type SnapshotMode = 'commits' | 'staged' | 'working';

export interface RepositoryVersionOption {
  value: string;
  label: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
}

export interface Requirement {
  id: string;
  kind: 'change' | 'preserve';
  text: string;
}

export interface SourceRef {
  id: string;
  side: Side;
  path: string;
  blobOid: string;
  startLine: number;
  endLine: number;
  code: string;
  role: 'change' | 'dependency' | 'candidate' | 'test' | 'reference';
  label: string;
  relatedChangeIds?: string[];
}

export interface Change {
  id: string;
  fileId: string;
  label: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  refIds: string[];
}

export interface ReviewFile {
  id: string;
  status: string;
  oldPath: string;
  path: string;
  oldOid: string;
  newOid: string;
  oldMode: string;
  newMode: string;
  before: string | null;
  after: string | null;
  additions: number;
  deletions: number;
  issue: string | null;
  changes: Change[];
}

export interface Snapshot {
  id: string;
  repo: string;
  base: string;
  target: string;
  mode?: SnapshotMode;
  untracked?: string[];
  requirements?: Requirement[];
  baseLabel: string;
  targetLabel: string;
  createdAt: string;
  files: ReviewFile[];
  refs: SourceRef[];
  gaps: string[];
}

export interface Statement {
  text: string;
  basis: 'source' | 'inference';
  refIds: string[];
}

export interface GuideGroup {
  title: string;
  changeIds: string[];
  before: Statement;
  after: Statement;
  notes: Statement[];
  questions: string[];
}

export interface Guide {
  overview: string;
  groups: GuideGroup[];
  unreviewed: { changeId: string; reason: string }[];
  limitations: string[];
  requirementLinks?: {
    requirementId: string;
    statement: Statement;
    changeIds: string[];
  }[];
  flowSteps?: {
    groupIndex: number;
    stage: '入口' | '输入' | '调用' | '状态' | '结果';
    statement: Statement;
  }[];
}

export interface GroupReviewState {
  status: 'understood' | 'question' | 'verified';
  evidence: string;
  guideHash: string;
  updatedAt: string;
}

export interface ClaimReviewState {
  status: 'confirmed' | 'question' | 'rejected';
  evidence: string;
  guideFingerprint: string;
  updatedAt: string;
}

export interface FileReviewState {
  status: 'in_progress' | 'question' | 'reviewed';
  fingerprint: string;
  updatedAt: string;
}

export interface HunkReviewState extends FileReviewState {
  inheritedFrom?: string;
}

export interface HunkEvidence {
  text: string;
  basis: 'source' | 'requirement' | 'mr' | 'inference' | 'pending';
  refIds: string[];
  requirementId?: string;
  mrExcerpt?: string;
}

export interface HunkExplanation {
  changeId: string;
  what: HunkEvidence;
  before: HunkEvidence;
  after: HunkEvidence;
  impacts: HunkEvidence[];
  failures: HunkEvidence[];
  tests: HunkEvidence[];
  pending: HunkEvidence[];
  guideFingerprint: string;
  fingerprint: string;
  createdAt: string;
}

export interface HunkUnderstandingState {
  status: 'understood' | 'question' | 'verified';
  evidence: string;
  guideFingerprint: string;
  explanationFingerprint: string;
  updatedAt: string;
}

export interface SymbolLocation {
  side: Side;
  path: string;
  blobOid: string;
  line: number;
  column: number;
  endColumn: number;
}

export interface SymbolRelation {
  id: string;
  kind: 'definition' | 'incoming_call' | 'outgoing_call' | 'read' | 'write' | 'argument' | 'return' | 'reference' | 'test';
  confidence: 'exact' | 'static_candidate' | 'text_candidate';
  from: string;
  to: string;
  label: string;
  change: 'added' | 'removed' | 'unchanged';
  locations: SymbolLocation[];
}

export interface SymbolNode {
  id: string;
  name: string;
  kind: string;
  locations: SymbolLocation[];
}

export interface SymbolImpact {
  snapshotId: string;
  selected: { name: string; kind: string; type: string; locations: SymbolLocation[] };
  nodes: SymbolNode[];
  relations: SymbolRelation[];
  indexedFiles: number;
  limitations: string[];
}

export interface IncrementalHunk {
  changeId: string;
  status: 'new' | 'unchanged' | 'ambiguous';
  previousChangeId?: string;
  reason: string;
}

export interface IncrementalFile {
  fileId?: string;
  previousFileId?: string;
  path: string;
  status: 'new' | 'modified' | 'unchanged' | 'removed' | 'ambiguous';
  reason: string;
  hunks: IncrementalHunk[];
  removedHunks: { changeId: string; label: string }[];
}

export interface IncrementalComparison {
  previousReviewId: string;
  previousVersionId: number;
  currentVersionId: number;
  origin: 'source-update' | 'base-update' | 'uncertain';
  files: IncrementalFile[];
}

export interface ReadingPosition {
  fileId: string;
  side: Side;
  line: number;
  changeId?: string;
}

export interface LocalComment {
  id: string;
  fileId: string;
  fingerprint: string;
  path: string;
  side: Side;
  line: number;
  body: string;
  evidence: string;
  createdAt: string;
  updatedAt: string;
  scope?: 'line' | 'range' | 'file';
  endLine?: number;
  category?: CommentCategory;
  suggestion?: string;
  resolved?: boolean;
  anchorStatus?: 'current' | 'pending';
  anchorReason?: string;
  inheritedFrom?: string;
}

export type CommentCategory = 'problem' | 'blocking' | 'suggestion' | 'detail';

export interface Answer {
  statements: Statement[];
  openQuestions: string[];
}

export interface SavedReview {
  snapshot: Snapshot;
  gitlab?: GitLabMergeRequest;
  commentDrafts?: CommentDraft[];
  localComments?: LocalComment[];
  fileStates?: Record<string, FileReviewState>;
  hunkStates?: Record<string, HunkReviewState>;
  hunkExplanations?: Record<string, HunkExplanation>;
  hunkUnderstandingStates?: Record<string, HunkUnderstandingState>;
  incremental?: IncrementalComparison;
  readingPosition?: ReadingPosition;
  guide: Guide | null;
  groupHashes?: string[];
  notes: Record<string, string>;
  answers: {
    question: string;
    groupIndex: number;
    groupTitle: string;
    answer: Answer;
    createdAt: string;
  }[];
  reviewStates?: Record<string, GroupReviewState>;
  claimStates?: Record<string, ClaimReviewState>;
  guideFingerprint?: string;
  verificationRecords?: VerificationRecord[];
}

export interface GitLabDiffFile {
  oldPath: string;
  path: string;
  addedLines: number[];
  deletedLines: number[];
}

export interface GitLabMergeRequest {
  url: string;
  projectPath: string;
  iid: number;
  title: string;
  description?: string;
  versionId: number;
  baseSha: string;
  headSha: string;
  startSha: string;
  files: GitLabDiffFile[];
}

export interface CommentDraft {
  id: string;
  path: string;
  oldPath: string;
  side: Side;
  line: number;
  body: string;
  evidence: string;
  versionId: number;
  createdAt: string;
  updatedAt: string;
  scope?: 'line' | 'range' | 'file';
  endLine?: number;
  category?: CommentCategory;
  suggestion?: string;
  resolved?: boolean;
  anchorStatus?: 'current' | 'pending';
  anchorReason?: string;
  inheritedFrom?: string;
}

export interface VerificationCase {
  id: string;
  title: string;
  focus: string;
  refIds: string[];
  unresolved: boolean;
}

export interface VerificationRecord {
  id: string;
  caseId: string;
  caseTitle: string;
  trigger: string;
  expected: string;
  scriptName: string;
  scriptBody: string;
  command: string[];
  snapshotId: string;
  target: string;
  guideFingerprint: string;
  imageId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface VerificationOptions {
  available: boolean;
  reason: string;
  image: string;
  scripts: { name: string; body: string }[];
  cases: VerificationCase[];
}

export interface VerificationTaskStatus {
  id: string;
  reviewId: string;
  state: 'running' | 'completed' | 'failed';
  error: string | null;
  recordId: string | null;
}

export interface ReviewSummary {
  id: string;
  repo: string;
  base: string;
  target: string;
  createdAt: string;
  files: number;
  hasGuide: boolean;
  mode?: SnapshotMode;
  gitlabUrl?: string;
  gitlabVersionId?: number;
}

export interface CodexStatus {
  available: boolean;
  subscription: boolean;
  version: string;
  message: string;
}

export interface TaskStatus {
  id: string;
  reviewId: string;
  kind: 'guide' | 'question' | 'hunk';
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  progress: string[];
  error: string | null;
}
