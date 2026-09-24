import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type {
  ClaimReviewState,
  CodexStatus,
  CommentDraft,
  CommentCategory,
  Change,
  LocalComment,
  ReadingPosition,
  ReviewSummary,
  ReviewFile,
  RepositoryVersionOption,
  SavedReview,
  Side,
  SnapshotMode,
  SourceRef,
  Statement,
  TaskStatus,
  SymbolImpact,
  SymbolLocation,
} from '../shared/types.js';
import { listClaims, type ReviewClaim } from '../shared/claims.js';
import { fileFingerprint, sourceLineCount } from '../shared/review-core.js';
import { featureFiles } from '../shared/feature-overview.js';
import { api } from './api.js';
import { CodePanel, StaticDiffPanel, type CommentMarker, type DiffJump, type SymbolPick } from './CodePanel.js';
import { V8ReviewPanel } from './V8ReviewPanel.js';
import { SymbolImpactPanel } from './SymbolImpactPanel.js';
import { currentFileStatus, defaultFileFilters, fileStatusCounts, filterFiles, type FileFilters, type FileStatus } from './file-review.js';

const short = (value: string) => value.slice(0, 8);
const basename = (value: string) => value.split('/').filter(Boolean).at(-1) ?? value;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function canonicalMrUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const match = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)(?:\/diffs)?\/?$/.exec(url.pathname);
    return url.protocol === 'https:' && !url.username && !url.password && match
      ? `${url.origin}/${match[1]}/-/merge_requests/${match[2]}` : null;
  } catch { return null; }
}
// GitLab 导入只提示对应的人工恢复动作，不能替用户配置凭证或获取本地提交。
function gitlabImportNextStep(problem: string): string {
  if (problem.includes('缺少 MR 提交'))
    return '请在所选本地仓库自行获取提示的 MR 提交，再重新导入；本工具不会执行 git fetch。';
  if (problem.includes('无权读取此 MR') || problem.includes('GitLab Token') || problem.includes('REVIEW_HELPER_GITLAB_HOST'))
    return '请在启动工具的环境中核对只读令牌的 MR 读取权限，以及 REVIEW_HELPER_GITLAB_HOST 与 MR 域名是否一致，重启后再试。';
  if (problem.includes('Git 远端不一致'))
    return '请选择与 MR 地址对应的本地 Git 仓库，或核对该仓库已配置的远端。';
  if (problem.includes('无法连接 GitLab'))
    return '请检查当前网络与 MR 链接，再重新导入。';
  return '请核对 MR 链接、所选本地仓库及错误详情后重试。';
}
const fileStatusLabel: Record<FileStatus, string> = {
  unread: '未阅读', in_progress: '审查中', question: '有疑问', reviewed: '已审查',
};
const filterStorageKey = 'diff-wingman:v6:file-filters';
const lastReviewStorageKey = 'diff-wingman:v6:last-review';

function readFileFilters(): FileFilters {
  try {
    const value = JSON.parse(localStorage.getItem(filterStorageKey) ?? 'null') as Partial<FileFilters> | null;
    if (!value || typeof value.query !== 'string' || !['all', 'added', 'modified', 'deleted', 'renamed'].includes(value.change ?? '') ||
      !['all', 'unreviewed', 'unread', 'in_progress', 'question', 'reviewed'].includes(value.status ?? '') ||
      !['all', 'source', 'test', 'config', 'style', 'docs', 'lock'].includes(value.category ?? '') ||
      typeof value.comments !== 'boolean' || typeof value.pending !== 'boolean' || typeof value.unavailable !== 'boolean')
      return defaultFileFilters;
    return value as FileFilters;
  } catch {
    // 浏览器禁用存储或旧偏好格式不兼容时，仅恢复筛选默认值，不影响审查记录。
    return defaultFileFilters;
  }
}

// 旧版导读和判断请求返回整份快照时，保留同时写入的文件状态与本地评论。
function mergeReviewCore(current: SavedReview | null, updated: SavedReview): SavedReview {
  if (current?.snapshot.id !== updated.snapshot.id) return updated;
  return { ...updated, fileStates: current.fileStates ?? updated.fileStates,
    hunkStates: current.hunkStates ?? updated.hunkStates,
    localComments: current.localComments ?? updated.localComments,
    commentDrafts: current.commentDrafts ?? updated.commentDrafts,
    incremental: current.incremental ?? updated.incremental };
}

const commentCategoryLabel: Record<CommentCategory, string> = {
  problem: '问题', blocking: '阻断', suggestion: '建议', detail: '细节',
};

function commentMarkers(review: SavedReview, file: ReviewFile): CommentMarker[] {
  const drafts = (review.commentDrafts ?? []).filter((item) => item.path === file.path &&
    item.scope !== 'file' && item.anchorStatus !== 'pending');
  const local = (review.localComments ?? []).filter((item) => item.fileId === file.id && item.path === file.path &&
    item.scope !== 'file' && item.anchorStatus !== 'pending');
  return [...drafts, ...local].map((item) => ({ side: item.side, line: item.line, resolved: item.resolved ?? false }));
}

function Icon({
  name,
  size = 18,
}: {
  name: 'branch' | 'spark' | 'file' | 'folder' | 'arrow' | 'clock' | 'check' | 'close' | 'trash';
  size?: number;
}) {
  const paths = {
    branch: (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="6" r="2" />
        <path d="M6 7v10M18 8c0 6-12 3-12 9" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z" />
        <path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z" />
      </>
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6Z" />
        <path d="M14 3v5h4M9 12h6M9 16h6" />
      </>
    ),
    folder: <path d="M3 6h7l2 2h9v11H3Z" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" /></>,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function EvidenceStatement({
  statement,
  refs,
  onRef,
}: {
  statement: Statement;
  refs: SourceRef[];
  onRef: (ref: SourceRef) => void;
}) {
  return (
    <div className="statement">
      <p>{statement.text}</p>
      <div className="evidence-row">
        <span className={`basis ${statement.basis}`}>
          {statement.basis === 'source' ? '源码依据' : '推断 · 待核实'}
        </span>
        {statement.refIds.map((id) => {
          const ref = refs.find((item) => item.id === id);
          return (
            ref && (
              <button
                className="ref-link"
                key={id}
                title={`${ref.path}:${ref.startLine}-${ref.endLine}`}
                onClick={() => onRef(ref)}
              >
                {ref.side === 'before' ? '前' : '后'} · {basename(ref.path)}:{ref.startLine}
              </button>
            )
          );
        })}
      </div>
    </div>
  );
}

function ClaimReviewCard({
  claim,
  refs,
  state,
  fingerprint,
  fresh,
  onRef,
  onSave,
}: {
  claim: ReviewClaim;
  refs: SourceRef[];
  state?: ClaimReviewState;
  fingerprint?: string;
  fresh: boolean | null;
  onRef: (ref: SourceRef) => void;
  onSave: (
    key: string,
    status: 'unread' | ClaimReviewState['status'],
    evidence: string,
  ) => Promise<boolean>;
}) {
  const valid = fresh === true && state?.guideFingerprint === fingerprint;
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] = useState<'unread' | ClaimReviewState['status']>('unread');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const current = state && state.guideFingerprint === fingerprint;
    setDecision(current ? state.status : 'unread');
    setEvidence(current ? state.evidence : '');
  }, [claim.key, fingerprint, state?.status, state?.evidence, state?.guideFingerprint]);
  const label = state
    ? `${valid ? '' : fresh === null ? '校验中 · 原' : '待重核 · 原'}${
        state.status === 'confirmed'
          ? '人工已确认'
          : state.status === 'rejected'
          ? '人工认为不成立'
          : '人工有疑问'
      }`
    : '未审查';
  return (
    <div className="claim-card">
      <EvidenceStatement statement={claim.statement} refs={refs} onRef={onRef} />
      <div className="claim-summary">
        <span>{label}</span>
        <button type="button" onClick={() => setEditing((value) => !value)}>
          {editing ? '收起' : '核对本条'}
        </button>
      </div>
      {editing && (
        <div className="claim-editor">
          <label>
            人工判断 · {claim.label}
            <select
              aria-label={`人工判断：${claim.label}`}
              value={decision}
              onChange={(event) => setDecision(event.target.value as typeof decision)}
            >
              <option value="unread">未审查</option>
              <option value="confirmed">已确认</option>
              <option value="question">有疑问</option>
              <option value="rejected">不成立</option>
            </select>
          </label>
          <label>
            人工依据或疑问
            <textarea
              aria-label={`人工依据：${claim.label}`}
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              rows={2}
              maxLength={5000}
              placeholder="记录核对过的行为、测试结果或尚缺的证据"
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={
              saving ||
              !fingerprint ||
              fresh !== true ||
              (decision !== 'unread' && !evidence.trim()) ||
              (decision === (valid ? state?.status : undefined) &&
                evidence === (valid ? state?.evidence : ''))
            }
            onClick={() => {
              setSaving(true);
              void onSave(claim.key, decision, evidence)
                .then((saved) => {
                  if (saved) setEditing(false);
                })
                .finally(() => setSaving(false));
            }}
          >
            {saving ? '保存中…' : '保存本条判断'}
          </button>
          {fresh !== true && <p>源码新鲜度尚未确认；请等待检查或建立新快照。</p>}
        </div>
      )}
    </div>
  );
}

function VersionPicker({
  field,
  value,
  options,
  placeholder,
  disabled,
  above = false,
  onSelect,
}: {
  field: '基线' | '目标';
  value: string;
  options: RepositoryVersionOption[];
  placeholder: string;
  disabled: boolean;
  above?: boolean;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'branch' | 'tag'>('branch');
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const tabs = useRef<{ branch: HTMLButtonElement | null; tag: HTMLButtonElement | null }>({
    branch: null,
    tag: null,
  });
  const selected = options.find((item) => item.value === value);
  // 只过滤候选项，不改真实 Git 引用；多个关键词不区分大小写且可分别命中路径片段。
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (item: RepositoryVersionOption) =>
    terms.every((term) => `${item.label} ${item.value}`.toLocaleLowerCase().includes(term));
  const branches = options.filter((item) => item.kind !== 'tag' && matches(item));
  const tags = options.filter((item) => item.kind === 'tag' && matches(item));
  const visible = tab === 'branch' ? branches : tags;
  const menuId = `version-menu-${field}`;
  const panelId = `version-panel-${field}`;

  // 仓库切换或离开提交比较时收起旧列表；点击外部和 Escape 也只关闭选择面板。
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div className="version-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="version-picker-trigger"
        aria-label={`选择${field}版本`}
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => {
          if (!open) {
            setTab(selected?.kind === 'tag' ? 'tag' : 'branch');
            setQuery('');
          }
          setOpen(!open);
        }}
      >
        <span>{selected?.label ?? placeholder}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={menuId} className={`version-picker-menu${above ? ' above' : ''}`}>
          <div
            className="version-picker-tabs"
            role="tablist"
            aria-label={`${field}版本类型`}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const next = tab === 'branch' ? 'tag' : 'branch';
              setTab(next);
              tabs.current[next]?.focus();
            }}
          >
            <button
              ref={(element) => { tabs.current.branch = element; }}
              id={`version-tab-branch-${field}`}
              type="button"
              role="tab"
              aria-selected={tab === 'branch'}
              aria-controls={panelId}
              tabIndex={tab === 'branch' ? 0 : -1}
              onClick={() => setTab('branch')}
            >
              分支 {branches.length}
            </button>
            <button
              ref={(element) => { tabs.current.tag = element; }}
              id={`version-tab-tag-${field}`}
              type="button"
              role="tab"
              aria-selected={tab === 'tag'}
              aria-controls={panelId}
              tabIndex={tab === 'tag' ? 0 : -1}
              onClick={() => setTab('tag')}
            >
              Tag {tags.length}
            </button>
          </div>
          <div className="version-picker-search-wrap">
            <input
              className="version-picker-search"
              type="search"
              aria-label={`搜索${field}版本`}
              placeholder="搜索分支或 Tag"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              autoFocus
            />
          </div>
          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={`version-tab-${tab}-${field}`}
            className="version-picker-list"
          >
            {visible.length ? visible.map((item) => (
              <button
                key={item.value}
                type="button"
                className={item.value === value ? 'selected' : ''}
                title={item.label}
                onClick={() => {
                  onSelect(item.value);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                {item.label}
              </button>
            )) : <p>{query.trim() ? '没有匹配的' : '暂无'}{tab === 'branch' ? '分支' : ' Tag'}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function FileNavItem({
  item,
  selected,
  onSelect,
  treeDepth,
  reviewStatus,
  historicalStatus,
}: {
  item: ReviewFile;
  selected: boolean;
  onSelect: (id: string) => void;
  treeDepth?: number;
  reviewStatus: FileStatus;
  historicalStatus?: FileStatus;
}) {
  return (
    <button
      type="button"
      className={`file-item ${selected ? 'active' : ''}${treeDepth === undefined ? '' : ' tree-file-item'}`}
      style={treeDepth === undefined ? undefined : { paddingLeft: `${8 + Math.min(treeDepth, 3) * 12}px` }}
      onClick={() => onSelect(item.id)}
      title={item.path}
    >
      <span className={`file-status ${item.status[0]}`}>{item.status[0]}</span>
      <span className="file-label">
        <strong>{basename(item.path)}</strong>
        {treeDepth === undefined && (
          <span>
            {item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '根目录'}
          </span>
        )}
      </span>
      <span className="file-count">
        {/* 内容未读取的文件没有可信行数，继续显示原有未分析标记。 */}
        {item.issue ? (
          '◇'
        ) : (
          <>
            <span className="added">+{item.additions}</span>
            <span className="deleted">−{item.deletions}</span>
          </>
        )}
      </span>
      <span className={`file-review-badge ${reviewStatus}`} title={historicalStatus ? `待重核 · 原${fileStatusLabel[historicalStatus]}` : undefined}>
        {historicalStatus ? `待重核 · 原${fileStatusLabel[historicalStatus]}` : fileStatusLabel[reviewStatus]}
      </span>
    </button>
  );
}

interface FileTreeNode {
  name: string;
  path: string;
  folders: Map<string, FileTreeNode>;
  files: ReviewFile[];
}

function FileTree({
  files,
  selectedFile,
  onSelect,
  review,
  fresh,
  stale,
}: {
  files: ReviewFile[];
  selectedFile: string | null;
  onSelect: (id: string) => void;
  review: SavedReview;
  fresh: boolean;
  stale: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // 树仅按快照里的目标路径分组；文件身份与点击行为仍使用原来的 id。
  const root: FileTreeNode = { name: '', path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    let parent = root;
    for (const name of parts) {
      let folder = parent.folders.get(name);
      if (!folder) {
        folder = {
          name,
          path: parent.path ? `${parent.path}/${name}` : name,
          folders: new Map(),
          files: [],
        };
        parent.folders.set(name, folder);
      }
      parent = folder;
    }
    parent.files.push(file);
  }

  // 阅读路线或源码引用切换文件时，确保树中对应目录可见。
  useEffect(() => {
    const file = files.find((item) => item.id === selectedFile);
    if (!file) return;
    const parents = file.path.split('/').slice(0, -1);
    setCollapsed((current) => {
      const next = new Set(current);
      let path = '';
      for (const part of parents) {
        path = path ? `${path}/${part}` : part;
        next.delete(path);
      }
      return next.size === current.size ? current : next;
    });
  }, [files, selectedFile]);

  const renderFiles = (node: FileTreeNode, depth: number) =>
    node.files.map((item) => (
      <FileNavItem
        key={item.id}
        item={item}
        selected={selectedFile === item.id}
        onSelect={onSelect}
        treeDepth={depth}
        reviewStatus={currentFileStatus(review, item, fresh)}
        historicalStatus={stale ? review.fileStates?.[item.id]?.status : undefined}
      />
    ));
  const renderFolder = (node: FileTreeNode, depth: number): React.ReactNode => {
    let current = node;
    let label = node.name;
    while (current.files.length === 0 && current.folders.size === 1) {
      current = [...current.folders.values()][0];
      label += `/${current.name}`;
    }
    const open = !collapsed.has(current.path);
    return (
      <div className="tree-folder" key={current.path}>
        <button
          type="button"
          className="tree-folder-trigger"
          style={{ paddingLeft: `${8 + Math.min(depth, 3) * 12}px` }}
          aria-expanded={open}
          aria-label={`${open ? '折叠' : '展开'}目录 ${current.path}`}
          title={current.path}
          onClick={() =>
            setCollapsed((value) => {
              const next = new Set(value);
              if (open) next.add(current.path);
              else next.delete(current.path);
              return next;
            })
          }
        >
          <span className={`tree-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span>
          <Icon name="folder" size={14} />
          <span className="tree-folder-name">{label}</span>
        </button>
        {open && (
          <div>
            {[...current.folders.values()].map((folder) => renderFolder(folder, depth + 1))}
            {renderFiles(current, depth + 1)}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="file-tree">
      {[...root.folders.values()].map((folder) => renderFolder(folder, 0))}
      {renderFiles(root, 0)}
    </div>
  );
}

// 左侧导航和 AI 总览共用固定快照中的功能归属，避免两个入口显示不同的文件与 hunk。
function FeatureList({ review, selectedGroup, onGroup, onChange, onUnreviewed }: {
  review: SavedReview;
  selectedGroup: number;
  onGroup: (index: number) => void;
  onChange: (index: number, file: ReviewFile, change: Change) => void;
  onUnreviewed: (file: ReviewFile, change: Change) => void;
}) {
  if (!review.guide) return null;
  return <div className="feature-list">
    {review.guide.groups.map((item, index) => {
      const files = featureFiles(review.snapshot, item);
      return <div className="feature-nav-entry" key={index}>
        <button type="button" className={`group-item ${selectedGroup === index ? 'active' : ''}`}
          aria-expanded={selectedGroup === index} onClick={() => onGroup(index)}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div><strong>{item.title}</strong>
            <small>{files.length} 个文件 · {item.changeIds.length} 处变更</small></div>
        </button>
        {selectedGroup === index && <div className="feature-file-list" aria-label={`${item.title}对应的文件改动`}>
          {files.map(({ file, changes }) => <div className="feature-file" key={file.id}>
            <button type="button" className="feature-file-name" title={file.path}
              onClick={() => onChange(index, file, changes[0])}>
              {file.path} <small>{changes.length} 处</small>
            </button>
            {changes.map((change) => <button type="button" className="feature-change" key={change.id}
              onClick={() => onChange(index, file, change)}>{change.label}</button>)}
          </div>)}
        </div>}
      </div>;
    })}
    {review.guide.unreviewed.length > 0 && <div className="unreviewed">
      <strong>未分析／待核对 · {review.guide.unreviewed.length}</strong>
      {review.guide.unreviewed.map((item) => {
        const file = review.snapshot.files.find((row) => row.changes.some((change) => change.id === item.changeId));
        const change = file?.changes.find((row) => row.id === item.changeId);
        return <button type="button" className="unreviewed-change" key={item.changeId}
          onClick={() => { if (file && change) onUnreviewed(file, change); }}>
          {file?.path} · {change?.label}：{item.reason}
        </button>;
      })}
    </div>}
  </div>;
}

function FileDiffCard({
  file,
  base,
  target,
  activeRef,
  diffLayout,
  showWhitespaceChanges,
  expanded,
  scrollRoot,
  onToggle,
  onLine,
  showFullFile,
  jump,
  onPosition,
  comments,
  featureChangeIds,
  onSymbol,
}: {
  file: ReviewFile;
  base: string;
  target: string;
  activeRef: SourceRef | null;
  diffLayout: 'side-by-side' | 'inline';
  showWhitespaceChanges: boolean;
  expanded: boolean;
  scrollRoot: React.RefObject<HTMLDivElement>;
  onToggle: () => void;
  onLine: (side: Side, line: number) => void;
  showFullFile: boolean;
  jump: DiffJump | null;
  onPosition: (side: Side, line: number) => void;
  comments: CommentMarker[];
  featureChangeIds: string[];
  onSymbol?: (selection: SymbolPick) => void;
}) {
  const card = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!card.current) return;
    // 多文件模式只渲染视口附近的行，避免大范围变更同时创建大量 DOM 节点。
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: scrollRoot.current, rootMargin: '350px' },
    );
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [expanded, scrollRoot]);
  return (
    <article className={`file-diff-card${expanded ? '' : ' collapsed'}`} data-file-id={file.id} ref={card}>
      <button className="file-diff-card-heading" type="button" title={file.path} aria-expanded={expanded} onClick={onToggle}>
        <span aria-hidden="true">{expanded ? '⌄' : '›'}</span> {file.path}
      </button>
      {expanded && (
        <>
          <div className="code-versions">
            <span>修改前 · {short(base)}</span>
            <span>修改后 · {short(target)}</span>
          </div>
          {file.status.startsWith('R') && (
            <div className="rename-note">重命名：{file.oldPath} → {file.path}</div>
          )}
          {visible ? (
            file.issue ? (
              <CodePanel file={file} activeRef={activeRef} onLine={onLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} showFullFile={showFullFile} jump={jump} onPosition={onPosition} comments={comments} featureChangeIds={featureChangeIds} onSymbol={onSymbol} />
            ) : (
              <StaticDiffPanel file={file} activeRef={activeRef} onLine={onLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} showFullFile={showFullFile} jump={jump} onPosition={onPosition} comments={comments} featureChangeIds={featureChangeIds} onSymbol={onSymbol} />
            )
          ) : (
            <div className="file-diff-placeholder" aria-hidden="true" />
          )}
        </>
      )}
    </article>
  );
}

export function App() {
  const [repo, setRepo] = useState('');
  const [pickingRepo, setPickingRepo] = useState(false);
  const [sourceKind, setSourceKind] = useState<'local' | 'gitlab'>('local');
  const [mrUrl, setMrUrl] = useState('');
  const [importError, setImportError] = useState('');
  const [previousReviewId, setPreviousReviewId] = useState('');
  const [mode, setMode] = useState<SnapshotMode>('commits');
  const [base, setBase] = useState('');
  const [target, setTarget] = useState('');
  const [versions, setVersions] = useState<{ repo: string; options: RepositoryVersionOption[] } | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState('');
  const [versionRefresh, setVersionRefresh] = useState(0);
  const [requirements, setRequirements] = useState('');
  const [preserve, setPreserve] = useState('');
  const [untracked, setUntracked] = useState<string[]>([]);
  const [selectedUntracked, setSelectedUntracked] = useState<string[]>([]);
  const [listingUntracked, setListingUntracked] = useState(false);
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [history, setHistory] = useState<ReviewSummary[]>([]);
  const [deletingReviewId, setDeletingReviewId] = useState<string | null>(null);
  const [review, setReview] = useState<SavedReview | null>(null);
  const [snapshotFormOpen, setSnapshotFormOpen] = useState(true);
  const reviewId = useRef<string | undefined>();
  reviewId.current = review?.snapshot.id;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const selectedFileRef = useRef<string | null>(null);
  selectedFileRef.current = selectedFile;
  const [readingPosition, setReadingPosition] = useState<ReadingPosition | null>(null);
  const [jump, setJump] = useState<DiffJump | null>(null);
  const jumpCounter = useRef(0);
  const persistedPosition = useRef('');
  const positionWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const fileStateWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const [selectedGroup, setSelectedGroup] = useState(0);
  const [activeRef, setActiveRef] = useState<SourceRef | null>(null);
  const [navigation, setNavigation] = useState<'files' | 'guide'>('files');
  const [fileView, setFileView] = useState<'list' | 'tree'>('list');
  const [diffLayout, setDiffLayout] = useState<'side-by-side' | 'inline'>('side-by-side');
  const [showWhitespaceChanges, setShowWhitespaceChanges] = useState(true);
  const [showOneFile, setShowOneFile] = useState(true);
  const [showFullFile, setShowFullFile] = useState(false);
  const [filters, setFilters] = useState<FileFilters>(readFileFilters);
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const allFilesScroll = useRef<HTMLDivElement>(null);
  const codeSectionRef = useRef<HTMLElement>(null);
  const reviewGridRef = useRef<HTMLDivElement>(null);
  const navigationPanelRef = useRef<HTMLElement>(null);
  const guidePanelRef = useRef<HTMLElement>(null);
  const resizeDrag = useRef<{ side: 'left' | 'right'; pointerId: number; startX: number; startWidth: number } | null>(null);
  const [navigationWidth, setNavigationWidth] = useState<number | null>(null);
  const [guideWidth, setGuideWidth] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [task, setTask] = useState<TaskStatus | null>(null);
  const [hunkMode, setHunkMode] = useState<'all' | 'on_demand' | null>(null);
  const [symbolPick, setSymbolPick] = useState<SymbolPick | null>(null);
  const [symbolImpactError, setSymbolImpactError] = useState('');
  const [symbolImpact, setSymbolImpact] = useState<SymbolImpact | null>(null);
  const [symbolImpactOpen, setSymbolImpactOpen] = useState(false);
  const [symbolImpactLoading, setSymbolImpactLoading] = useState(false);
  const [error, setError] = useState('');
  const [freshness, setFreshness] = useState<{ fresh: boolean; reason?: string } | null>(null);
  const [reportPreview, setReportPreview] = useState<{ reviewId: string; markdown: string } | null>(
    null,
  );
  const [draftPath, setDraftPath] = useState('');
  const [draftSide, setDraftSide] = useState<Side>('after');
  const [draftLine, setDraftLine] = useState('');
  const [draftScope, setDraftScope] = useState<'line' | 'range' | 'file'>('line');
  const [draftEndLine, setDraftEndLine] = useState('');
  const [draftCategory, setDraftCategory] = useState<CommentCategory>('problem');
  const [draftSuggestion, setDraftSuggestion] = useState('');
  const [draftResolved, setDraftResolved] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [draftEvidence, setDraftEvidence] = useState('');
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftExport, setDraftExport] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<ReadingPosition | null>(null);
  const [editingLocalCommentId, setEditingLocalCommentId] = useState<string | null>(null);
  const [savingLocalComment, setSavingLocalComment] = useState(false);
  const commentOverviewRef = useRef<HTMLDetailsElement>(null);
  const commentSectionRef = useRef<HTMLDetailsElement>(null);
  const commentBodyRef = useRef<HTMLTextAreaElement>(null);
  const mrPanelRef = useRef<HTMLDetailsElement>(null);
  const loadCounter = useRef(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<CodexStatus>('/api/status'),
      api<ReviewSummary[]>('/api/reviews'),
      api<TaskStatus[]>('/api/tasks'),
    ])
      .then(([nextStatus, nextHistory, tasks]) => {
        if (!alive) return;
        setStatus(nextStatus);
        setHistory(nextHistory);
        if (tasks[0]) setTask(tasks[0]);
        try {
          const lastId = localStorage.getItem(lastReviewStorageKey);
          if (lastId && nextHistory.some((item) => item.id === lastId) && loadCounter.current === 0)
            void api<SavedReview>(`/api/reviews/${lastId}`).then((value) => {
              if (alive && loadCounter.current === 0) openReview(value);
            }).catch((error) => { if (alive) setError(message(error)); });
        } catch { /* 存储不可用时仍可从最近快照手动打开。 */ }
      })
      .catch((error) => {
        if (alive) setError(message(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(filterStorageKey, JSON.stringify(filters)); }
    catch { /* 浏览器拒绝本地偏好存储时，当前会话仍可筛选。 */ }
  }, [filters]);

  // 仓库确定后只读本地引用；延迟手输路径请求，取消旧请求避免切仓时显示过期候选项。
  useEffect(() => {
    setVersions(null);
    setVersionError('');
    if (!repo || sourceKind !== 'local' || mode !== 'commits') {
      setVersionLoading(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setVersionLoading(true);
    const timer = setTimeout(() => {
      void api<RepositoryVersionOption[]>('/api/repository/versions', {
        method: 'POST',
        body: { repo },
        signal: controller.signal,
      })
        .then((options) => {
          if (alive) setVersions({ repo, options });
        })
        .catch((error) => {
          if (alive) setVersionError(message(error));
        })
        .finally(() => {
          if (alive) setVersionLoading(false);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [repo, sourceKind, mode, versionRefresh]);

  useEffect(() => {
    if (!task || task.state !== 'running') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await api<TaskStatus>(`/api/tasks/${task.id}`, { signal: controller.signal });
        if (!alive) return;
        if (next.state === 'completed') {
          const [updated, recent] = await Promise.all([
            api<SavedReview>(`/api/reviews/${next.reviewId}`, { signal: controller.signal }),
            api<ReviewSummary[]>('/api/reviews', { signal: controller.signal }),
          ]);
          if (!alive) return;
          if (reviewId.current === next.reviewId) {
            setReview((current) => current?.snapshot.id === next.reviewId ? mergeReviewCore(current, updated) : current);
            setReportPreview(null);
          }
          setHistory(recent);
        } else if (next.state === 'failed') setError(next.error ?? '导读失败。');
        setTask(next);
        if (next.state === 'running') timer = setTimeout(poll, 1200);
      } catch (error) {
        if (alive) {
          setError(message(error));
          setTask((current) =>
            current ? { ...current, state: 'failed', error: message(error) } : null,
          );
        }
      }
    };
    timer = setTimeout(poll, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [task?.id, task?.state]);

  const snapshot = review?.snapshot;
  useEffect(() => {
    // 文件 id 在每个快照内从 file-1 重新编号，切换快照时不能沿用折叠状态。
    setCollapsedFiles(new Set());
    setSelectedGroup(0);
  }, [snapshot?.id]);
  const file = snapshot?.files.find((item) => item.id === selectedFile) ?? null;
  const fileStatesFresh = freshness?.fresh === true || Boolean(review && !review.gitlab && (!snapshot?.mode || snapshot.mode === 'commits'));
  const visibleFiles = review ? filterFiles(review, filters, fileStatesFresh) : [];
  const statusCounts = review ? fileStatusCounts(review, fileStatesFresh) : { reviewed: 0, question: 0, unreviewed: 0 };
  const visibleHunks = visibleFiles.flatMap((item) => item.changes.filter((change) => change.id.includes(':hunk-')).map((change) => ({ file: item, change })));
  const activeHunkIndex = visibleHunks.findIndex(({ change }) => change.id === readingPosition?.changeId);
  const group = review?.guide?.groups[selectedGroup];
  const focusedChangeIds = navigation === 'guide' ? group?.changeIds ?? [] : [];
  const busy = requesting || task?.state === 'running';
  const changes = snapshot?.files.flatMap((item) => item.changes) ?? [];
  const claims = review?.guide ? listClaims(review.guide) : [];
  const claimByKey = new Map(claims.map((claim) => [claim.key, claim]));
  const overviewComments = [
    ...(review?.commentDrafts ?? []).map((comment) => ({ kind: 'mr' as const, comment })),
    ...(review?.localComments ?? []).map((comment) => ({ kind: 'local' as const, comment })),
  ];

  useEffect(() => {
    if (!review || !readingPosition) return;
    const serialized = JSON.stringify(readingPosition);
    if (persistedPosition.current === `${review.snapshot.id}:${serialized}`) return;
    const savingId = review.snapshot.id;
    const timer = setTimeout(() => {
      const write = positionWriteQueue.current.catch(() => undefined).then(() =>
        api(`/api/reviews/${savingId}/reading-position`, { method: 'PUT', body: readingPosition }));
      positionWriteQueue.current = write.then(() => undefined, () => undefined);
      void write
        .then(() => { persistedPosition.current = `${savingId}:${serialized}`; })
        .catch((error) => { if (savingId === reviewId.current) setError(message(error)); });
    }, 300);
    return () => clearTimeout(timer);
  }, [review?.snapshot.id, readingPosition]);
  useEffect(() => {
    if (
      !review?.snapshot.id ||
      (!review.gitlab && (!review.snapshot.mode || review.snapshot.mode === 'commits'))
    ) {
      setFreshness({ fresh: true });
      return;
    }
    let alive = true;
    const check = () => {
      void api<{ fresh: boolean; reason?: string }>(`/api/reviews/${review.snapshot.id}/freshness`)
        .then((value) => {
          if (alive) setFreshness(value);
        })
        .catch((error) => {
          if (alive) setError(message(error));
        });
    };
    setFreshness(null);
    check();
    const timer = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [review?.snapshot.id]);

  const openReview = (value: SavedReview) => {
    setRepo(value.snapshot.repo);
    setSourceKind(value.gitlab ? 'gitlab' : 'local');
    setMrUrl(value.gitlab?.url ?? '');
    setPreviousReviewId(value.incremental?.previousReviewId ?? '');
    setMode(value.snapshot.mode ?? 'commits');
    setBase(value.gitlab ? value.snapshot.base : value.snapshot.baseLabel);
    setTarget(value.gitlab ? value.snapshot.target : value.snapshot.targetLabel);
    setRequirements(
      (value.snapshot.requirements ?? [])
        .filter((item) => item.kind === 'change')
        .map((item) => item.text)
        .join('\n'),
    );
    setPreserve(
      (value.snapshot.requirements ?? [])
        .filter((item) => item.kind === 'preserve')
        .map((item) => item.text)
        .join('\n'),
    );
    setSelectedUntracked(value.snapshot.untracked ?? []);
    setUntracked([]);
    setReview(value);
    // 建档成功后收起抽屉；再次展开只改变展示，不触碰固定快照和审查记录。
    setSnapshotFormOpen(false);
    setHunkMode(null);
    setSymbolPick(null);
    setSymbolImpactError('');
    setImportError('');
    setSymbolImpact(null);
    setSymbolImpactOpen(false);
    setFreshness(null);
    const savedPosition = value.readingPosition;
    const savedFile = value.snapshot.files.find((item) => item.id === savedPosition?.fileId);
    const source = savedPosition?.side === 'before' ? savedFile?.before : savedFile?.after;
    const restored = savedPosition && savedFile && source !== null && source !== undefined &&
      savedPosition.line <= sourceLineCount(source) ? savedPosition : null;
    const firstFile = value.snapshot.files[0];
    const first = firstFile && firstPosition(firstFile);
    const initialPosition = restored ?? (firstFile && first ? positionFor(firstFile, first.side, first.line) : null);
    setSelectedFile(initialPosition?.fileId ?? firstFile?.id ?? null);
    setReadingPosition(initialPosition);
    persistedPosition.current = restored ? `${value.snapshot.id}:${JSON.stringify(restored)}` : '';
    setJump(initialPosition ? { side: initialPosition.side, line: initialPosition.line, token: ++jumpCounter.current } : null);
    try { localStorage.setItem(lastReviewStorageKey, value.snapshot.id); }
    catch { /* 最近快照恢复不可用时，已加载的快照仍可阅读。 */ }
    setActiveRef(null);
    setSelectedGroup(0);
    setNavigation(value.guide ? 'guide' : 'files');
    setFileView('list');
    setReportPreview(null);
    setDraftPath(
      value.gitlab?.files.find((item) => item.addedLines.length || item.deletedLines.length)
        ?.path ?? '',
    );
    setDraftSide('after');
    setDraftLine('');
    setDraftScope('line');
    setDraftEndLine('');
    setDraftCategory('problem');
    setDraftSuggestion('');
    setDraftResolved(false);
    setDraftBody('');
    setDraftEvidence('');
    setEditingDraftId(null);
    setDraftExport(null);
    setCommentTarget(null);
    setEditingLocalCommentId(null);
  };
  async function loadReview(id: string) {
    const request = ++loadCounter.current;
    setError('');
    try {
      const value = await api<SavedReview>(`/api/reviews/${id}`);
      if (request === loadCounter.current) openReview(value);
    } catch (error) {
      if (request === loadCounter.current) setError(message(error));
    }
  }
  async function deleteSnapshot(item: ReviewSummary) {
    if (!window.confirm(`确定永久删除“${basename(item.repo)}”这份快照？\n本机保存的导读和评论会一起删除，无法恢复；源码仓库和 GitLab 不受影响。`)) return;
    ++loadCounter.current;
    setDeletingReviewId(item.id);
    setError('');
    try {
      await api<{ deleted: string }>(`/api/reviews/${item.id}`, { method: 'DELETE' });
      setHistory((current) => current.filter((row) => row.id !== item.id));
      try {
        if (localStorage.getItem(lastReviewStorageKey) === item.id) localStorage.removeItem(lastReviewStorageKey);
      } catch { /* 本地存储不可用时，仍以服务端删除结果为准。 */ }
      setTask((current) => current?.reviewId === item.id ? null : current);
      if (reviewId.current === item.id) {
        // 删除当前快照后回到建档页，清除阅读位置，避免重新载入已删除的记录。
        setReview(null);
        setSnapshotFormOpen(true);
        setSelectedFile(null);
        setReadingPosition(null);
        setJump(null);
        setActiveRef(null);
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setDeletingReviewId(null);
    }
  }
  async function createReview(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError('');
    setImportError('');
    const request = ++loadCounter.current;
    try {
      const value = await api<SavedReview>(
        sourceKind === 'gitlab' ? '/api/gitlab/import' : '/api/snapshots',
        {
          method: 'POST',
          body:
            sourceKind === 'gitlab'
              ? { repo, url: mrUrl, requirements, preserve, ...(previousReviewId ? { previousReviewId } : {}) }
              : {
                  repo,
                  mode,
                  ...(mode === 'commits' ? { base, target } : {}),
                  ...(mode === 'working' ? { untracked: selectedUntracked } : {}),
                  requirements,
                  preserve,
                },
        },
      );
      if (request === loadCounter.current) openReview(value);
      try { setHistory(await api<ReviewSummary[]>('/api/reviews')); }
      catch (error) { setError(message(error)); }
    } catch (error) {
      if (sourceKind === 'gitlab') setImportError(message(error));
      else setError(message(error));
    } finally {
      setCreating(false);
    }
  }
  async function loadUntracked() {
    setListingUntracked(true);
    setError('');
    try {
      const paths = await api<string[]>('/api/untracked', { method: 'POST', body: { repo } });
      setUntracked(paths);
      setSelectedUntracked((current) => current.filter((item) => paths.includes(item)));
    } catch (error) {
      setError(message(error));
    } finally {
      setListingUntracked(false);
    }
  }
  async function chooseRepository() {
    setPickingRepo(true);
    setError('');
    try {
      const result = await api<{ repo: string } | { cancelled: true }>('/api/repository/pick', {
        method: 'POST',
      });
      if ('repo' in result) {
        setRepo(result.repo);
        setPreviousReviewId('');
        setVersionRefresh((current) => current + 1);
        setUntracked([]);
        setSelectedUntracked([]);
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setPickingRepo(false);
    }
  }
  async function saveClaim(
    key: string,
    status: 'unread' | ClaimReviewState['status'],
    evidence: string,
  ): Promise<boolean> {
    if (!review?.guideFingerprint) return false;
    const savingId = review.snapshot.id;
    setError('');
    try {
      const updated = await api<SavedReview>(`/api/reviews/${savingId}/claims`, {
        method: 'PUT',
        body: { key, guideFingerprint: review.guideFingerprint, status, evidence },
      });
      setReview((current) => (current?.snapshot.id === savingId ? mergeReviewCore(current, updated) : current));
      setReportPreview(null);
      return true;
    } catch (error) {
      setError(message(error));
      return false;
    }
  }
  async function exportReport() {
    if (!snapshot || !review?.guide) return;
    setError('');
    try {
      const result = await api<{ filename: string; markdown: string }>(
        `/api/reviews/${snapshot.id}/report`,
      );
      setReportPreview({ reviewId: snapshot.id, markdown: result.markdown });
      const url = URL.createObjectURL(
        new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(message(error));
    }
  }
  async function exportDrafts() {
    if (!snapshot?.id) return;
    setError('');
    try {
      const result = await api<{ filename: string; markdown: string }>(
        `/api/reviews/${snapshot.id}/drafts/export`,
      );
      setDraftExport(result.markdown);
      const url = URL.createObjectURL(
        new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(message(error));
    }
  }
  async function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!snapshot?.id || !review?.gitlab) return;
    const savingId = snapshot.id;
    setSavingDraft(true);
    setError('');
    try {
      const updated = await api<SavedReview>(
        editingDraftId
          ? `/api/reviews/${savingId}/drafts/${editingDraftId}`
          : `/api/reviews/${savingId}/drafts`,
        {
          method: editingDraftId ? 'PUT' : 'POST',
          body: { path: draftPath, side: draftSide, line: draftScope === 'file' ? 0 : Number(draftLine),
            scope: draftScope, ...(draftScope === 'range' ? { endLine: Number(draftEndLine) } : {}),
            category: draftCategory, suggestion: draftSuggestion, resolved: draftResolved,
            body: draftBody, evidence: draftEvidence },
        },
      );
      if (reviewId.current === savingId) {
        setReview((current) => current?.snapshot.id === savingId ? { ...current, commentDrafts: updated.commentDrafts } : current);
        setDraftBody('');
        setDraftEvidence('');
        setDraftScope('line');
        setDraftEndLine('');
        setDraftCategory('problem');
        setDraftSuggestion('');
        setDraftResolved(false);
        setDraftLine('');
        setEditingDraftId(null);
        setDraftExport(null);
        setReportPreview(null);
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setSavingDraft(false);
    }
  }
  async function deleteDraft(draft: CommentDraft) {
    if (!snapshot?.id) return;
    const savingId = snapshot.id;
    setError('');
    try {
      const updated = await api<SavedReview>(`/api/reviews/${savingId}/drafts/${draft.id}`, {
        method: 'DELETE',
      });
      if (reviewId.current === savingId) {
        setReview((current) => current?.snapshot.id === savingId ? { ...current, commentDrafts: updated.commentDrafts } : current);
        setDraftExport(null);
        setReportPreview(null);
        if (editingDraftId === draft.id) setEditingDraftId(null);
      }
    } catch (error) {
      setError(message(error));
    }
  }
  function beginEditDraft(draft: CommentDraft) {
    setEditingDraftId(draft.id);
    setDraftPath(review?.gitlab?.files.some((item) => item.path === draft.path) ? draft.path : review?.gitlab?.files[0]?.path ?? '');
    setDraftSide(draft.side);
    setDraftLine(draft.anchorStatus === 'pending' ? '' : String(draft.line));
    setDraftScope(draft.scope ?? 'line');
    setDraftEndLine(draft.anchorStatus === 'pending' ? '' : draft.endLine === undefined ? '' : String(draft.endLine));
    setDraftCategory(draft.category ?? 'problem');
    setDraftSuggestion(draft.suggestion ?? '');
    setDraftResolved(draft.resolved ?? false);
    setDraftBody(draft.body);
    setDraftEvidence(draft.evidence);
    requestAnimationFrame(() => { if (mrPanelRef.current) { mrPanelRef.current.open = true; mrPanelRef.current.scrollIntoView({ block: 'nearest' }); } });
  }
  function beginEditLocalComment(comment: LocalComment, targetFile: ReviewFile) {
    const first = firstPosition(targetFile);
    const target = comment.anchorStatus === 'pending'
      ? { fileId: targetFile.id, side: first?.side ?? 'after', line: comment.scope === 'file' ? 0 : first?.line ?? 0 }
      : { fileId: targetFile.id, side: comment.side, line: comment.line };
    setCommentTarget(target);
    setEditingLocalCommentId(comment.id);
    setDraftScope(comment.scope ?? 'line');
    setDraftEndLine(comment.anchorStatus === 'pending' ? '' : comment.endLine === undefined ? '' : String(comment.endLine));
    setDraftCategory(comment.category ?? 'problem');
    setDraftSuggestion(comment.suggestion ?? '');
    setDraftResolved(comment.resolved ?? false);
    setDraftBody(comment.body);
    setDraftEvidence(comment.evidence);
    requestAnimationFrame(() => { if (commentSectionRef.current) { commentSectionRef.current.open = true; commentSectionRef.current.scrollIntoView({ block: 'nearest' }); } commentBodyRef.current?.focus(); });
  }
  async function saveLocalComment(event: React.FormEvent) {
    event.preventDefault();
    if (!review || !commentTarget || !file) return;
    const savingId = review.snapshot.id;
    setSavingLocalComment(true);
    setError('');
    try {
      const updated = await api<SavedReview>(
        editingLocalCommentId
          ? `/api/reviews/${savingId}/local-comments/${editingLocalCommentId}`
          : `/api/reviews/${savingId}/local-comments`,
        {
          method: editingLocalCommentId ? 'PUT' : 'POST',
          body: { fileId: file.id, fingerprint: fileFingerprint(file), side: commentTarget.side,
            line: draftScope === 'file' ? 0 : commentTarget.line, scope: draftScope,
            ...(draftScope === 'range' ? { endLine: Number(draftEndLine) } : {}),
            category: draftCategory, suggestion: draftSuggestion, resolved: draftResolved,
            body: draftBody, evidence: draftEvidence },
        },
      );
      if (reviewId.current === savingId) {
        setReview((current) => current?.snapshot.id === savingId ? { ...current, localComments: updated.localComments } : current);
        setCommentTarget(null);
        setEditingLocalCommentId(null);
        setDraftBody('');
        setDraftEvidence('');
        setDraftScope('line');
        setDraftEndLine('');
        setDraftCategory('problem');
        setDraftSuggestion('');
        setDraftResolved(false);
      }
    } catch (error) { setError(message(error)); }
    finally { setSavingLocalComment(false); }
  }
  async function deleteLocalComment(comment: LocalComment) {
    if (!snapshot) return;
    const savingId = snapshot.id;
    try {
      const updated = await api<SavedReview>(`/api/reviews/${savingId}/local-comments/${comment.id}`, { method: 'DELETE' });
      if (reviewId.current === savingId)
        setReview((current) => current?.snapshot.id === savingId ? { ...current, localComments: updated.localComments } : current);
      if (editingLocalCommentId === comment.id) {
        setEditingLocalCommentId(null);
        setCommentTarget(null);
      }
    } catch (error) { setError(message(error)); }
  }
  async function copyDraft(draft: CommentDraft) {
    if (!snapshot?.id) return;
    setError('');
    try {
      const current = await api<{ fresh: boolean; reason?: string }>(
        `/api/reviews/${snapshot.id}/freshness`,
      );
      setFreshness(current);
      if (!current.fresh) throw new Error(current.reason ?? 'MR 版本已变化，请重新核对草稿。');
      if (draft.versionId !== review?.gitlab?.versionId)
        throw new Error('草稿对应的 diff 版本已失效。');
      const fence = '`'.repeat(Math.max(3, ...[...(draft.suggestion ?? '').matchAll(/`+/g)].map((match) => match[0].length + 1)));
      await navigator.clipboard.writeText(`${draft.body}${draft.suggestion ? `\n\n${fence}suggestion\n${draft.suggestion}\n${fence}` : ''}\n\n人工依据：${draft.evidence}`);
    } catch (error) {
      setError(message(error));
    }
  }
  async function generate() {
    if (!snapshot || busy || !hunkMode) return;
    setRequesting(true);
    setError('');
    try {
      setTask(await api<TaskStatus>(`/api/reviews/${snapshot.id}/guide`, { method: 'POST', body: { hunkMode } }));
    } catch (error) {
      setError(message(error));
    } finally {
      setRequesting(false);
    }
  }
  // 单块解释沿用已有任务轮询和取消流程；只有明确触发时才调用 Codex。
  async function generateHunk(changeId: string) {
    if (!snapshot || busy) return;
    setRequesting(true);
    setError('');
    try {
      setTask(await api<TaskStatus>(`/api/reviews/${snapshot.id}/hunk-explanations`, {
        method: 'POST', body: { changeId },
      }));
    } catch (error) {
      setError(message(error));
    } finally {
      setRequesting(false);
    }
  }
  async function updateHunkUnderstanding(changeId: string, status: 'unread' | 'understood' | 'question' | 'verified', evidence: string) {
    if (!review?.guideFingerprint) return;
    const card = review.hunkExplanations?.[changeId];
    if (!card) return;
    try {
      const updated = await api<SavedReview>(`/api/reviews/${review.snapshot.id}/hunk-understanding`, {
        method: 'PUT', body: { changeId, status, evidence, guideFingerprint: review.guideFingerprint,
          explanationFingerprint: card.fingerprint },
      });
      setReview((current) => current?.snapshot.id === updated.snapshot.id ? mergeReviewCore(current, updated) : current);
    } catch (error) { setError(message(error)); }
  }
  async function loadSymbolImpact(pick: SymbolPick, expand = false) {
    if (!snapshot || symbolImpactLoading) return;
    setSymbolImpactLoading(true);
    setError('');
    setSymbolImpactError('');
    try {
      const result = await api<SymbolImpact>(`/api/reviews/${snapshot.id}/symbol-impact`, {
        method: 'POST', body: { path: pick.path, side: pick.side, line: pick.line,
          startColumn: pick.startColumn, endColumn: pick.endColumn, expand },
      });
      if (reviewId.current !== result.snapshotId) return;
      setSymbolImpact((current) => {
        if (!expand || !current || current.snapshotId !== result.snapshotId) return result;
        // 展开另一层时合并同一关系的固定位置，不能覆盖前一层已展示的证据。
        const nodes = new Map(current.nodes.map((node) => [node.id, node]));
        for (const node of result.nodes) {
          const previous = nodes.get(node.id);
          nodes.set(node.id, previous ? { ...previous, locations: [...previous.locations,
            ...node.locations.filter((loc) => !previous.locations.some((old) => old.side === loc.side &&
              old.blobOid === loc.blobOid && old.line === loc.line && old.column === loc.column))] } : node);
        }
        const relations = new Map(current.relations.map((relation) => [relation.id, relation]));
        for (const relation of result.relations) {
          const previous = relations.get(relation.id);
          if (!previous) { relations.set(relation.id, relation); continue; }
          const locations = [...previous.locations, ...relation.locations.filter((loc) => !previous.locations.some((old) =>
            old.side === loc.side && old.blobOid === loc.blobOid && old.line === loc.line && old.column === loc.column))];
          const sides = new Set(locations.map((loc) => loc.side));
          relations.set(relation.id, { ...previous, locations,
            change: sides.size === 2 ? 'unchanged' : sides.has('after') ? 'added' : 'removed' });
        }
        return { ...current, nodes: [...nodes.values()], relations: [...relations.values()],
          limitations: [...new Set([...current.limitations, ...result.limitations])] };
      });
      setSymbolImpactOpen(true);
    } catch (error) { setSymbolImpactError(message(error)); }
    finally { setSymbolImpactLoading(false); }
  }
  function selectSymbol(pick: SymbolPick) {
    setSymbolPick(pick);
    setSymbolImpactError('');
  }
  async function navigateImpactLocation(location: SymbolLocation, fileOnly = false) {
    if (!snapshot) return;
    const matching = snapshot.files.find((item) => location.side === 'before' ?
      item.oldPath === location.path && item.oldOid === location.blobOid :
      item.path === location.path && item.newOid === location.blobOid);
    if (matching) {
      if (fileOnly) chooseFile(matching.id);
      else jumpTo(matching, location.side, location.line);
      setSymbolImpactOpen(false);
      return;
    }
    try {
      const ref = await api<SourceRef>(`/api/reviews/${snapshot.id}/symbol-source`, {
        method: 'POST', body: { side: location.side, path: location.path,
          blobOid: location.blobOid, line: location.line },
      });
      if (reviewId.current === snapshot.id) { showRef(ref); setSymbolImpactOpen(false); }
    } catch (error) { setError(message(error)); }
  }
  function scrollToDiffFile(id: string) {
    const container = allFilesScroll.current;
    const card = [...(container?.querySelectorAll<HTMLElement>('[data-file-id]') ?? [])].find(
      (item) => item.dataset.fileId === id,
    );
    card?.scrollIntoView({ block: 'nearest' });
  }
  useEffect(() => {
    if (!showOneFile && selectedFile) scrollToDiffFile(selectedFile);
  }, [showOneFile, selectedFile, snapshot?.id]);
  function positionFor(sourceFile: ReviewFile, side: Side, line: number): ReadingPosition {
    const hunks = sourceFile.changes.filter((item) => item.id.includes(':hunk-'));
    const nearest = hunks.reduce<{ id: string; distance: number } | null>((best, item) => {
      const start = side === 'before' ? item.oldStart : item.newStart;
      const count = side === 'before' ? item.oldLines : item.newLines;
      const distance = line < start ? start - line : Math.max(0, line - (start + count - 1));
      return !best || distance < best.distance ? { id: item.id, distance } : best;
    }, null);
    return { fileId: sourceFile.id, side, line, ...(nearest ? { changeId: nearest.id } : {}) };
  }
  function jumpTo(sourceFile: ReviewFile, side: Side, line: number) {
    if (!showOneFile) {
      setCollapsedFiles((current) => {
        if (!current.has(sourceFile.id)) return current;
        const next = new Set(current);
        next.delete(sourceFile.id);
        return next;
      });
    }
    setSelectedFile(sourceFile.id);
    setActiveRef(null);
    setReadingPosition(positionFor(sourceFile, side, line));
    setJump({ side, line, token: ++jumpCounter.current });
  }
  // 功能导航落到该功能的具体变更块；元数据变更没有可定位的文本行，只选择文件。
  function jumpToChange(sourceFile: ReviewFile, change: Change) {
    if (change.newLines > 0) jumpTo(sourceFile, 'after', change.newStart);
    else if (change.oldLines > 0) jumpTo(sourceFile, 'before', change.oldStart);
    else chooseFile(sourceFile.id);
  }
  function focusCodeAfterMatrix() {
    // 窄窗口中 AI 面板在代码下方，关闭矩阵后需要把当前 hunk 重新带回视口。
    if (!window.matchMedia('(max-width: 1020px)').matches) return;
    requestAnimationFrame(() => {
      codeSectionRef.current?.focus({ preventScroll: true });
      codeSectionRef.current?.scrollIntoView({ block: 'start' });
    });
  }
  function firstPosition(sourceFile: ReviewFile): { side: Side; line: number } | null {
    const first = sourceFile.changes.find((item) => item.id.includes(':hunk-'));
    if (first && first.newLines > 0) return { side: 'after', line: first.newStart };
    if (first && first.oldLines > 0) return { side: 'before', line: first.oldStart };
    if (sourceFile.after && sourceLineCount(sourceFile.after)) return { side: 'after', line: 1 };
    if (sourceFile.before && sourceLineCount(sourceFile.before)) return { side: 'before', line: 1 };
    return null;
  }
  function chooseFile(id: string) {
    // 列表与树形视图共享文件选择，切换视图不改变当前 diff 和人工记录。
    if (!showOneFile) {
      setCollapsedFiles((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      requestAnimationFrame(() => scrollToDiffFile(id));
    }
    const sourceFile = snapshot?.files.find((item) => item.id === id);
    const start = sourceFile && firstPosition(sourceFile);
    if (sourceFile && start) jumpTo(sourceFile, start.side, start.line);
    else {
      setSelectedFile(id);
      setActiveRef(null);
      setReadingPosition(null);
      setJump(null);
      }
  }
  function showRef(ref: SourceRef) {
    if (!snapshot) return;
    const matching = snapshot.files.find((item) =>
      ref.side === 'before' ? item.oldPath === ref.path : item.path === ref.path,
    );
    setSelectedFile(matching?.id ?? null);
    setActiveRef(ref);
    if (matching) {
      setReadingPosition(positionFor(matching, ref.side, ref.startLine));
      setJump({ side: ref.side, line: ref.startLine, token: ++jumpCounter.current });
    }
  }
  function chooseGroup(index: number) {
    setSelectedGroup(index);
    const firstChange = changes.find((change) =>
      review?.guide?.groups[index].changeIds.includes(change.id),
    );
    if (firstChange) {
      const sourceFile = snapshot?.files.find((item) => item.id === firstChange.fileId);
      if (sourceFile) jumpToChange(sourceFile, firstChange);
    }
  }
  function chooseFeatureChange(index: number, sourceFile: ReviewFile, change: Change) {
    // 从 AI 总览跳转时沿用阅读路线的功能高亮，不改变文件审查或人工理解状态。
    setNavigation('guide');
    setSelectedGroup(index);
    jumpToChange(sourceFile, change);
  }
  function chooseLine(side: Side, line: number, sourceFile: ReviewFile | null = file) {
    if (!sourceFile || !snapshot) return;
    setReadingPosition(positionFor(sourceFile, side, line));
    if (sourceFile.id !== selectedFile) {
      setSelectedFile(sourceFile.id);
      setActiveRef(null);
    }
    const mrFile = review?.gitlab?.files.find((item) => item.path === sourceFile.path);
    if (mrFile && (side === 'after' ? mrFile.addedLines : mrFile.deletedLines).includes(line)) {
      setDraftPath(mrFile.path);
      setDraftSide(side);
      setDraftLine(String(line));
    }
    const ref = snapshot.refs.find(
      (item) =>
        item.side === side &&
        item.path === (side === 'before' ? sourceFile.oldPath : sourceFile.path) &&
        line >= item.startLine &&
        line <= item.endLine,
    );
    // 同文件跨功能时优先按实际 hunk 归属切换；宽范围源码引用可能同时覆盖多个 hunk。
    const changedHunk = sourceFile.changes.find((change) => {
      const start = side === 'before' ? change.oldStart : change.newStart;
      const count = side === 'before' ? change.oldLines : change.newLines;
      return change.id.includes(':hunk-') && count > 0 && line >= start && line < start + count;
    });
    if (changedHunk && review?.guide) {
      setSelectedGroup(review.guide.groups.findIndex((item) => item.changeIds.includes(changedHunk.id)));
    }
    if (ref) {
      setActiveRef(ref);
      if (!changedHunk) {
        const index = review?.guide?.groups.findIndex((group) =>
          group.changeIds.some((id) =>
            sourceFile.changes.some((change) => change.id === id && change.refIds.includes(ref.id)),
          ),
        );
        if (index !== undefined && index >= 0) setSelectedGroup(index);
      }
    }
  }

  function recordScrollPosition(sourceFile: ReviewFile, side: Side, line: number) {
    if (selectedFileRef.current !== sourceFile.id || line < 1) return;
    setReadingPosition((current) => {
      if (current?.fileId === sourceFile.id && current.side === side && current.line === line) return current;
      return positionFor(sourceFile, side, line);
    });
  }
  function navigateFile(direction: -1 | 1) {
    if (!visibleFiles.length) return;
    const index = visibleFiles.findIndex((item) => item.id === selectedFile);
    const next = index < 0 ? (direction === 1 ? 0 : visibleFiles.length - 1) :
      (index + direction + visibleFiles.length) % visibleFiles.length;
    chooseFile(visibleFiles[next].id);
  }
  function navigateHunk(direction: -1 | 1) {
    if (!visibleHunks.length) return;
    const index = activeHunkIndex < 0 ? (direction === 1 ? -1 : 0) : activeHunkIndex;
    const target = visibleHunks[(index + direction + visibleHunks.length) % visibleHunks.length];
    const side: Side = target.change.newLines > 0 ? 'after' : 'before';
    jumpTo(target.file, side, side === 'after' ? target.change.newStart : target.change.oldStart);
  }
  function nextUnreviewedFile() {
    if (!snapshot || !review) return;
    const index = snapshot.files.findIndex((item) => item.id === selectedFile);
    const candidates = visibleFiles.filter((item) => ['unread', 'in_progress'].includes(currentFileStatus(review, item, fileStatesFresh)));
    const target = candidates.find((item) => snapshot.files.indexOf(item) > index) ?? candidates[0];
    if (target) chooseFile(target.id);
  }
  async function updateFileStatus(status: FileStatus) {
    if (!review || !file || !fileStatesFresh) return;
    const savingId = review.snapshot.id;
    const targetFile = file;
    try {
      const write = fileStateWriteQueue.current.catch(() => undefined).then(() =>
        api<SavedReview>(`/api/reviews/${savingId}/file-states`, {
          method: 'PUT', body: { fileId: targetFile.id, fingerprint: fileFingerprint(targetFile), status },
        }));
      fileStateWriteQueue.current = write.then(() => undefined, () => undefined);
      const updated = await write;
      if (reviewId.current === savingId) setReview((current) => {
        if (current?.snapshot.id !== savingId) return current;
        const fileStates = { ...current.fileStates };
        const saved = updated.fileStates?.[targetFile.id];
        if (saved) fileStates[targetFile.id] = saved;
        else delete fileStates[targetFile.id];
        return { ...current, fileStates };
      });
    } catch (error) { setError(message(error)); }
  }
  function openComment() {
    if (!file || !review || freshness?.fresh !== true && !fileStatesFresh) return;
    const first = firstPosition(file);
    const target = readingPosition?.fileId === file.id ? readingPosition :
      first ? positionFor(file, first.side, first.line) : null;
    if (!target) { setError('此文件没有可评论的文本行。'); return; }
    if (review.gitlab) {
      const mrFile = review.gitlab.files.find((item) => item.path === file.path);
      if (!mrFile || !(target.side === 'after' ? mrFile.addedLines : mrFile.deletedLines).includes(target.line)) {
        setError('GitLab 草稿只能定位到新增或删除行，请先点击对应代码行。');
        return;
      }
      setDraftPath(file.path);
      setDraftSide(target.side);
      setDraftLine(String(target.line));
      setDraftScope('line');
      setDraftEndLine('');
      if (mrPanelRef.current) {
        mrPanelRef.current.open = true;
        mrPanelRef.current.scrollIntoView({ block: 'nearest' });
      }
    } else {
      setCommentTarget(target);
      setEditingLocalCommentId(null);
      setDraftScope('line');
      setDraftEndLine('');
      setDraftBody('');
      setDraftEvidence('');
      requestAnimationFrame(() => {
        if (commentSectionRef.current) {
          commentSectionRef.current.open = true;
          commentSectionRef.current.scrollIntoView({ block: 'nearest' });
        }
        commentBodyRef.current?.focus();
      });
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!review || event.metaKey || event.ctrlKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor')) return;
      if (!event.altKey && event.key === '/') {
        event.preventDefault();
        setNavigation('files');
        fileSearchRef.current?.focus();
      } else if (event.altKey && event.key === 'ArrowUp') {
        event.preventDefault(); navigateFile(-1);
      } else if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault(); navigateFile(1);
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault(); navigateHunk(-1);
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault(); navigateHunk(1);
      } else if (event.altKey && event.key.toLowerCase() === 'r') {
        event.preventDefault(); void updateFileStatus('reviewed');
      } else if (event.altKey && event.key.toLowerCase() === 'c') {
        event.preventDefault(); openComment();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    // 筛选恢复后选中可见文件；导读定位到清单外源码时保留原引用位置。
    if (!review || navigation !== 'files' || activeRef) return;
    if (selectedFile && visibleFiles.some((item) => item.id === selectedFile)) return;
    const first = visibleFiles[0];
    if (first) chooseFile(first.id);
    else { setSelectedFile(null); setReadingPosition(null); setJump(null); }
  }, [review, filters, navigation, selectedFile, activeRef, freshness?.fresh]);

  const renderClaim = (key: string) => {
    const claim = claimByKey.get(key);
    if (!claim || !snapshot) return null;
    return (
      <ClaimReviewCard
        key={`${review?.guideFingerprint}:${key}`}
        claim={claim}
        refs={snapshot.refs}
        state={review?.claimStates?.[key]}
        fingerprint={review?.guideFingerprint}
        fresh={freshness?.fresh ?? null}
        onRef={showRef}
        onSave={saveClaim}
      />
    );
  };
  const versionOptions = versions?.repo === repo ? versions.options : [];
  const versionPlaceholder = !repo
    ? '先选择本地仓库'
    : versionLoading
      ? '正在读取仓库版本…'
      : versionError
        ? '读取失败，可手动填写'
        : versionOptions.length
          ? '从仓库版本中选择'
          : '没有可选择的版本';
  const reviewGridStyle = {
    '--review-nav-width': navigationWidth === null ? undefined : `${navigationWidth}px`,
    '--review-guide-width': guideWidth === null ? undefined : `${guideWidth}px`,
  } as CSSProperties;

  // 两侧栏仅调整阅读布局；拖动时保留中间源码的可读宽度，窄屏仍走原有布局。
  function updateReviewPanelWidth(side: 'left' | 'right', requestedWidth: number) {
    const grid = reviewGridRef.current;
    const other = (side === 'left' ? guidePanelRef : navigationPanelRef).current;
    if (!grid || !other) return;
    const gridWidth = grid.getBoundingClientRect().width;
    const otherWidth = other.getBoundingClientRect().width;
    const minimum = side === 'left' ? 150 : 250;
    const maximum = Math.max(minimum, Math.min(
      side === 'left' ? 420 : 600,
      gridWidth * (side === 'left' ? 0.3 : 0.4),
      gridWidth - otherWidth - 250,
    ));
    const width = Math.round(Math.max(minimum, Math.min(requestedWidth, maximum)));
    if (side === 'left') setNavigationWidth(width);
    else setGuideWidth(width);
  }
  function beginReviewPanelResize(side: 'left' | 'right', event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const panel = (side === 'left' ? navigationPanelRef : guidePanelRef).current;
    if (!panel) return;
    resizeDrag.current = { side, pointerId: event.pointerId, startX: event.clientX,
      startWidth: panel.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveReviewPanelResize(side: 'left' | 'right', event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = resizeDrag.current;
    if (!drag || drag.side !== side || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    updateReviewPanelWidth(side, drag.startWidth + (side === 'left' ? delta : -delta));
    event.preventDefault();
  }
  function endReviewPanelResize(side: 'left' | 'right', event: ReactPointerEvent<HTMLButtonElement>) {
    if (resizeDrag.current?.side === side && resizeDrag.current.pointerId === event.pointerId) resizeDrag.current = null;
  }
  function keyReviewPanelResize(side: 'left' | 'right', event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const panel = (side === 'left' ? navigationPanelRef : guidePanelRef).current;
    if (!panel) return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 20 : -20;
    updateReviewPanelWidth(side, panel.getBoundingClientRect().width + (side === 'left' ? delta : -delta));
  }

  return (
    <div className="app-shell">
      <div className={`app-body${review ? ` review-drawer${snapshotFormOpen ? ' drawer-open' : ''}` : ''}`}>
        {review && snapshotFormOpen && <button type="button" className="snapshot-drawer-backdrop" aria-label="收起选择" onClick={() => setSnapshotFormOpen(false)} />}
        <aside className="sidebar" id="snapshot-sidebar">
          <a className="brand" href="/" aria-label="Diff Wingman 首页">
            <span className="brand-mark">
              <Icon name="branch" size={22} />
            </span>
            <span>
              Diff<span className="brand-light"> Wingman</span>
            </span>
            <span className="version-tag">v0.0.13</span>
          </a>
          <div className="sidebar-heading">
            <Icon name="branch" />
            <span>建立审查快照</span>
            {review && <button type="button" className="sidebar-collapse" onClick={() => setSnapshotFormOpen(false)}>收起</button>}
          </div>
          <p className="sidebar-description">选择源码范围，固定待审查的内容。</p>
          <form className="snapshot-form" onSubmit={createReview}>
            <div className="repo-field">
              <label htmlFor="repo-path">{repo ? basename(repo) : '本地仓库'}</label>
              <div className="repo-input-row">
                <input
                  id="repo-path"
                  aria-label="本地仓库路径"
                  required
                  value={repo}
                  onChange={(event) => {
                    setRepo(event.target.value);
                    setImportError('');
                    setPreviousReviewId('');
                    setUntracked([]);
                    setSelectedUntracked([]);
                  }}
                  placeholder="/path/to/repository"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pickingRepo}
                  onClick={() => void chooseRepository()}
                >
                  {pickingRepo ? '选择中…' : '选择文件夹'}
                </button>
              </div>
            </div>
            <label>
              来源
              <select
                aria-label="来源"
                value={sourceKind}
                onChange={(event) => { setSourceKind(event.target.value as 'local' | 'gitlab'); setImportError(''); }}
              >
                <option value="local">本地 Git 版本</option>
                <option value="gitlab">GitLab MR（只读）</option>
              </select>
            </label>
            {sourceKind === 'gitlab' ? (
              <>
                <label>
                  GitLab MR 链接
                  <input
                    required
                    type="url"
                    value={mrUrl}
                    onChange={(event) => { setMrUrl(event.target.value); setPreviousReviewId(''); setImportError(''); }}
                    placeholder="https://gitlab.example.com/group/project/-/merge_requests/1"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
                <label>
                  上次审查版本 <span>可选，手动选择</span>
                  <select aria-label="上次审查版本" value={previousReviewId} onChange={(event) => setPreviousReviewId(event.target.value)}>
                    <option value="">无，查看完整 MR diff</option>
                    {history.filter((item) => item.repo === repo && item.gitlabUrl === canonicalMrUrl(mrUrl)).map((item) =>
                      <option key={item.id} value={item.id}>diff v{item.gitlabVersionId} · {item.gitlabUrl} · {short(item.id)}</option>)}
                  </select>
                </label>
                <div className="gitlab-import-help">
                  私有 MR：在启动工具的环境中配置与 MR 域名一致的 <code>REVIEW_HELPER_GITLAB_HOST</code> 和具备读取权限的只读 <code>REVIEW_HELPER_GITLAB_TOKEN</code>。所选本地仓库须已有 MR 的基线与目标提交；缺少时请自行获取，本工具不会自动 fetch 或发布评论。
                </div>
              </>
            ) : (
              <label>
                审查范围
                <select
                  aria-label="审查范围"
                  value={mode}
                  onChange={(event) => {
                    setMode(event.target.value as SnapshotMode);
                    setUntracked([]);
                    setSelectedUntracked([]);
                  }}
                >
                  <option value="commits">两个提交版本</option>
                  <option value="staged">HEAD → 暂存区</option>
                  <option value="working">HEAD → 当前工作区</option>
                </select>
              </label>
            )}
            {sourceKind === 'local' && mode === 'commits' && (
              <>
                <div className="version-field">
                  <label htmlFor="base-version">基线版本 <span>BEFORE</span></label>
                  <input
                    id="base-version"
                    required
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                    placeholder="分支、tag 或 commit"
                    spellCheck={false}
                  />
                  <VersionPicker
                    field="基线"
                    value={base}
                    options={versionOptions}
                    placeholder={versionPlaceholder}
                    disabled={!versionOptions.length || versionLoading}
                    onSelect={setBase}
                  />
                </div>
                <div className="version-connector">
                  <Icon name="arrow" size={14} />
                </div>
                <div className="version-field">
                  <label htmlFor="target-version">目标版本 <span>AFTER</span></label>
                  <input
                    id="target-version"
                    required
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    placeholder="例如：HEAD"
                    spellCheck={false}
                  />
                  <VersionPicker
                    field="目标"
                    value={target}
                    options={versionOptions}
                    placeholder={versionPlaceholder}
                    disabled={!versionOptions.length || versionLoading}
                    above
                    onSelect={setTarget}
                  />
                  {versionError && <small className="version-error">{versionError}</small>}
                </div>
              </>
            )}
            {sourceKind === 'local' && mode === 'working' && (
              <div className="untracked-picker">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!repo || listingUntracked}
                  onClick={() => void loadUntracked()}
                >
                  {listingUntracked ? '读取中…' : '选择未跟踪文件'}
                </button>
                <p>已跟踪文件自动纳入；未跟踪文件需要逐项勾选。</p>
                {untracked.length > 0 && (
                  <div className="untracked-list">
                    {untracked.map((filePath) => (
                      <label key={filePath} title={filePath}>
                        <input
                          type="checkbox"
                          checked={selectedUntracked.includes(filePath)}
                          onChange={(event) =>
                            setSelectedUntracked((current) =>
                              event.target.checked
                                ? [...current, filePath]
                                : current.filter((item) => item !== filePath),
                            )
                          }
                        />
                        <span>{filePath}</span>
                      </label>
                    ))}
                  </div>
                )}
                {selectedUntracked.length > 0 && (
                  <small>已选择 {selectedUntracked.length} 个文件</small>
                )}
              </div>
            )}
            <label>
              本次需求 <span>可选，每行一项</span>
              <textarea
                value={requirements}
                onChange={(event) => setRequirements(event.target.value)}
                rows={3}
                maxLength={10000}
                placeholder="写明要实现或修改的行为"
              />
            </label>
            <label>
              不得改变项 <span>可选，每行一项</span>
              <textarea
                value={preserve}
                onChange={(event) => setPreserve(event.target.value)}
                rows={2}
                maxLength={10000}
                placeholder="写明需要保持的行为"
              />
            </label>
            <button className="primary-button" type="submit" disabled={creating}>
              {creating ? (
                <>
                  <span className="spinner" />
                  {sourceKind === 'gitlab' ? '导入 MR…' : '读取版本…'}
                </>
              ) : (
                <>
                  {sourceKind === 'gitlab' ? '导入 MR 快照' : '打开变更'}
                  <Icon name="arrow" size={16} />
                </>
              )}
            </button>
            {sourceKind === 'gitlab' && importError && (
              <div className="gitlab-import-error" role="alert">
                <strong>导入失败：{importError}</strong>
                <p>{gitlabImportNextStep(importError)}</p>
              </div>
            )}
          </form>
          <div className="scope-note">
            <span className="tiny-check">✓</span>
            <p>
              {sourceKind === 'gitlab'
                ? '读取 MR 版本，对应本地 Git 对象'
                : mode === 'commits'
                ? '比较两个 commit 端点'
                : '从 HEAD 读取提交前快照'}
              <br />
              {sourceKind === 'gitlab'
                ? '不修改 MR 或被审查仓库'
                : mode === 'commits'
                ? '不包含未提交的工作区修改'
                : '不会修改被审查仓库'}
            </p>
          </div>
          <div className="history-heading">
            <span>
              <Icon name="clock" size={15} />
              最近快照
            </span>
            <span>{history.length}</span>
          </div>
          <div className="history-list">
            {history.length ? (
              history.map((item) => {
                const running = task?.reviewId === item.id && task.state === 'running';
                return <div className="history-row" key={item.id}>
                  <button
                    className={`history-item ${snapshot?.id === item.id ? 'active' : ''}`}
                    disabled={deletingReviewId !== null}
                    onClick={() => void loadReview(item.id)}
                  >
                    <span className="history-title">
                      {basename(item.repo)}
                      {item.gitlabUrl && <span title={item.gitlabUrl}> · MR</span>}
                      {item.hasGuide && <span className="history-guide-dot" title="已有导读" />}
                    </span>
                    <span className="mono">
                      {short(item.base)} →{' '}
                      {item.mode === 'staged'
                        ? '暂存区'
                        : item.mode === 'working'
                        ? '工作区'
                        : short(item.target)}
                    </span>
                    <span className="history-meta">
                      {item.files} 个文件 · {new Date(item.createdAt).toLocaleDateString('zh-CN')}
                    </span>
                  </button>
                  <button type="button" className="history-delete"
                    aria-label={`删除快照 ${basename(item.repo)} ${short(item.id)}`}
                    title={running ? '任务运行中，暂不能删除此快照' : '删除快照'}
                    disabled={deletingReviewId !== null || running}
                    onClick={() => void deleteSnapshot(item)}>
                    <Icon name="trash" size={15} />
                  </button>
                </div>;
              })
            ) : (
              <p className="muted small">打开的快照会保存在本机。</p>
            )}
          </div>
          <div className="sidebar-footer">
            <span className="status-dot online" />
            源码只读 · 审查记录本地保存
          </div>
        </aside>
        <main className="workspace">
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError('')}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {task && (
            <div className={`task-banner ${task.state}`} role="status">
              <span>
                {task.state === 'running' ? (
                  <span className="spinner" />
                ) : (
                  <Icon name={task.state === 'completed' ? 'check' : 'clock'} size={15} />
                )}
              </span>
              <span>{task.state === 'failed' ? task.error : task.progress.at(-1)}</span>
              {snapshot?.id !== task.reviewId && (
                <button className="text-button" onClick={() => void loadReview(task.reviewId)}>
                  打开对应快照
                </button>
              )}
              {task.state === 'running' ? (
                <button
                  className="text-button"
                  onClick={() => {
                    void api<TaskStatus>(`/api/tasks/${task.id}/cancel`, { method: 'POST' })
                      .then(setTask)
                      .catch((error) => setError(message(error)));
                  }}
                >
                  取消
                </button>
              ) : (
                <button
                  className="icon-button"
                  aria-label="关闭任务提示"
                  onClick={() => setTask(null)}
                >
                  <Icon name="close" size={15} />
                </button>
              )}
            </div>
          )}
          {!review || !snapshot ? (
            <div className="welcome">
              <div className="welcome-eyebrow">
                <span /> UNDERSTAND THE CHANGE
              </div>
              <h1>
                从看见变更，
                <br />
                到理解代码。
              </h1>
              <p className="welcome-intro">
                把分散的 diff 串成一条阅读路线。
                <br />
                看清行为变化，沿源码核对每一个解释。
              </p>
              <div className="welcome-steps">
                <div>
                  <span className="step-number">01</span>
                  <h3>固定版本</h3>
                  <p>
                    保留修改前后的真实源码，
                    <br />
                    让每条解释都有明确出处。
                  </p>
                </div>
                <div>
                  <span className="step-number">02</span>
                  <h3>沿线阅读</h3>
                  <p>
                    从业务变化进入代码，
                    <br />
                    查看上下文与关键规则。
                  </p>
                </div>
                <div>
                  <span className="step-number">03</span>
                  <h3>核对理解</h3>
                  <p>
                    点击证据、核对细节，
                    <br />
                    记录自己的审查判断。
                  </p>
                </div>
              </div>
              <div className="welcome-bottom">
                <Icon name="branch" size={16} />
                <span>从左侧选择本地仓库和审查范围开始</span>
              </div>
            </div>
          ) : (
            <>
              <div className="review-heading">
                <div>
                  <div className="review-title-row">
                    <h1>
                      {basename(snapshot.repo)} <span className="snapshot-badge">固定快照</span>
                    </h1>
                    <button type="button" className="snapshot-select-button" aria-controls="snapshot-sidebar"
                      aria-expanded={snapshotFormOpen} onClick={() => setSnapshotFormOpen((open) => !open)}>
                      重新选择
                    </button>
                  </div>
                  <div className="snapshot-meta">
                    <p title={snapshot.repo}>{snapshot.repo}</p>
                    <details className="comment-overview" ref={commentOverviewRef}>
                      <summary>评论 {overviewComments.length} · 未解决 {overviewComments.filter((item) => !item.comment.resolved).length}</summary>
                      <div className="mr-panel-content">
                        <p>评论状态只保存在本机；“已解决”不改变 GitLab 讨论状态。</p>
                        {overviewComments.length === 0 && <p>当前快照尚无评论。</p>}
                        {overviewComments.map((item) => {
                          const comment = item.comment;
                          const destination = item.kind === 'local'
                            ? snapshot.files.find((row) => row.id === item.comment.fileId && row.path === comment.path)
                            : snapshot.files.find((row) => row.path === comment.path);
                          return <div className="mr-draft-item" key={`${item.kind}:${comment.id}`}>
                            <strong>{commentCategoryLabel[comment.category ?? 'problem']} · {comment.path}{comment.scope === 'file' ? ' · 文件级' : `:${comment.line}${comment.scope === 'range' ? `-${comment.endLine}` : ''}`}</strong>
                            <span>{comment.resolved ? '已解决' : '未解决'} · {comment.anchorStatus === 'pending' ? '待重新定位' : '位置有效'} · {item.kind === 'mr' ? 'MR 本地草稿' : '本地评论'}</span>
                            <p>{comment.body}</p>
                            {comment.anchorReason && <small>{comment.anchorReason}</small>}
                            <div className="mr-actions">
                              <button type="button" className="secondary-button" disabled={!destination || comment.anchorStatus === 'pending'} onClick={() => {
                                if (!destination) return;
                                if (commentOverviewRef.current) commentOverviewRef.current.open = false;
                                comment.scope === 'file' ? chooseFile(destination.id) : jumpTo(destination, comment.side, comment.line);
                              }}>定位到 diff</button>
                              {comment.anchorStatus === 'pending' && (item.kind === 'mr'
                                ? <button type="button" className="secondary-button" disabled={freshness?.fresh !== true} onClick={() => { if (commentOverviewRef.current) commentOverviewRef.current.open = false; beginEditDraft(item.comment); }}>重新定位</button>
                                : <button type="button" className="secondary-button" disabled={!file || !fileStatesFresh} onClick={() => { if (file) { if (commentOverviewRef.current) commentOverviewRef.current.open = false; beginEditLocalComment(item.comment, file); } }}>在当前文件重新定位</button>)}
                            </div>
                          </div>;
                        })}
                      </div>
                    </details>
                  </div>
                </div>
                <div className="review-stats">
                  <div className="commit-range">
                    <span title={`${snapshot.baseLabel}\n${snapshot.base}`}>
                      {short(snapshot.base)}
                    </span>
                    <Icon name="arrow" size={14} />
                    <span title={`${snapshot.targetLabel}\n${snapshot.target}`}>
                      {snapshot.mode === 'staged'
                        ? '暂存区'
                        : snapshot.mode === 'working'
                        ? '工作区'
                        : short(snapshot.target)}
                    </span>
                  </div>
                  <div>
                    <span>{snapshot.files.length} 个文件</span>
                    <span className="added">
                      +{snapshot.files.reduce((sum, file) => sum + file.additions, 0)}
                    </span>
                    <span className="deleted">
                      −{snapshot.files.reduce((sum, file) => sum + file.deletions, 0)}
                    </span>
                  </div>
                </div>
              </div>
              {review.incremental && <details className="mr-panel incremental-panel" open>
                <summary>增量复审 · diff v{review.incremental.previousVersionId} → v{review.incremental.currentVersionId}</summary>
                <div className="mr-panel-content">
                  <p>完整 MR 范围仍为 merge base → 最新 source HEAD。本轮来源：{
                    review.incremental.origin === 'source-update' ? 'source HEAD 变化；是否为作者修改需结合提交核对' :
                    review.incremental.origin === 'base-update' ? 'merge base 变化；请核对目标分支更新影响' :
                    '仅凭版本信息无法可靠区分 rebase 与作者修改，待确认'
                  }。</p>
                  <div className="incremental-list">
                    {review.incremental.files.map((item, index) => {
                      const current = snapshot.files.find((file) => file.id === item.fileId);
                      const label = { new: '本轮新增', modified: '再次修改', unchanged: '保持不变', removed: '已移除', ambiguous: '待确认' }[item.status];
                      return <div className="incremental-item" key={`${item.fileId ?? item.previousFileId}-${index}`}>
                        <strong>{label} · {item.path}</strong><span>{item.reason}</span>
                        {current && <button type="button" className="text-button" onClick={() => chooseFile(current.id)}>查看 diff</button>}
                        {item.hunks.length > 0 && <small>{item.hunks.filter((hunk) => hunk.status === 'unchanged').length} 块内容不变 · {item.hunks.filter((hunk) => hunk.status === 'new').length} 块需复审 · {item.hunks.filter((hunk) => hunk.status === 'ambiguous').length} 块待确认</small>}
                        {item.hunks.some((hunk) => hunk.reason.includes('上下文') || hunk.status === 'ambiguous') &&
                          <details className="incremental-hunk-reasons"><summary>查看变更块对应原因</summary>
                            {item.hunks.map((hunk) => <p key={hunk.changeId}>{current?.changes.find((change) => change.id === hunk.changeId)?.label ?? hunk.changeId}：{hunk.reason}</p>)}
                          </details>}
                        {item.removedHunks.length > 0 && <details className="incremental-hunk-reasons"><summary>旧版 {item.removedHunks.length} 个变更块已移除或需确认</summary>
                          {item.removedHunks.map((hunk) => <p key={hunk.changeId}>{hunk.label} · {hunk.changeId}</p>)}
                        </details>}
                      </div>;
                    })}
                  </div>
                </div>
              </details>}
              {review.gitlab && (
                <details className="mr-panel" ref={mrPanelRef}>
                  <summary>
                    GitLab MR !{review.gitlab.iid} · 本地评论草稿{' '}
                    {review.commentDrafts?.length ?? 0} 条
                  </summary>
                  <div className="mr-panel-content">
                    <p>
                      <a href={review.gitlab.url} target="_blank" rel="noopener noreferrer">
                        {review.gitlab.title}
                      </a>
                      {' · '}diff 版本 {review.gitlab.versionId} · 只读导入
                    </p>
                    <p>
                      草稿只存本机。点击 diff 中的新增或删除行可带入位置；复制前会重新检查 MR 版本。
                    </p>
                    <form className="mr-draft-form" onSubmit={saveDraft}>
                      <label>
                        文件
                        <select
                          aria-label="草稿文件"
                          value={draftPath}
                          onChange={(event) => {
                            setDraftPath(event.target.value);
                            setDraftLine('');
                          }}
                        >
                          <option value="">选择变更文件</option>
                          {review.gitlab.files.map((item) => (
                              <option key={item.path} value={item.path}>
                                {item.path}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        位置类型
                        <select aria-label="草稿位置类型" value={draftScope} onChange={(event) => { setDraftScope(event.target.value as typeof draftScope); setDraftEndLine(''); }}>
                          <option value="line">单行</option><option value="range">多行</option><option value="file">文件级</option>
                        </select>
                      </label>
                      <label>
                        侧别
                        <select
                          aria-label="草稿侧别"
                          value={draftSide}
                          disabled={draftScope === 'file'}
                          onChange={(event) => {
                            setDraftSide(event.target.value as Side);
                            setDraftLine('');
                          }}
                        >
                          <option value="after">新增行</option>
                          <option value="before">删除行</option>
                        </select>
                      </label>
                      {draftScope !== 'file' && <label>
                        行号
                        <input
                          aria-label="草稿行号"
                          type="number"
                          min="1"
                          required
                          value={draftLine}
                          onChange={(event) => setDraftLine(event.target.value)}
                        />
                      </label>}
                      {draftScope === 'range' && <label>
                        结束行号
                        <input aria-label="草稿结束行号" type="number" min="1" required value={draftEndLine} onChange={(event) => setDraftEndLine(event.target.value)} />
                      </label>}
                      <small className="mr-lines">
                        当前可评论行：
                        {(() => {
                          const item = review.gitlab!.files.find((row) => row.path === draftPath);
                          const lines =
                            draftSide === 'after' ? item?.addedLines : item?.deletedLines;
                          return lines?.length
                            ? `${lines.slice(0, 30).join('、')}${
                                lines.length > 30 ? ` 等 ${lines.length} 行` : ''
                              }`
                            : '无';
                        })()}
                      </small>
                      <label>
                        评论类型
                        <select aria-label="草稿评论类型" value={draftCategory} onChange={(event) => { const category = event.target.value as CommentCategory; setDraftCategory(category); if (category !== 'suggestion') setDraftSuggestion(''); }}>
                          {Object.entries(commentCategoryLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                        </select>
                      </label>
                      <label>
                        本地状态
                        <select aria-label="草稿解决状态" value={draftResolved ? 'resolved' : 'open'} onChange={(event) => setDraftResolved(event.target.value === 'resolved')}>
                          <option value="open">未解决</option><option value="resolved">已解决</option>
                        </select>
                      </label>
                      {draftCategory === 'suggestion' && <label className="mr-wide">
                        修改建议代码块
                        <textarea aria-label="草稿修改建议代码" maxLength={5000} rows={4} value={draftSuggestion} onChange={(event) => setDraftSuggestion(event.target.value)} />
                      </label>}
                      <label className="mr-wide">
                        问题描述
                        <textarea
                          aria-label="评论问题描述"
                          required
                          maxLength={5000}
                          rows={2}
                          value={draftBody}
                          onChange={(event) => setDraftBody(event.target.value)}
                        />
                      </label>
                      <label className="mr-wide">
                        人工验证依据
                        <textarea
                          aria-label="评论人工依据"
                          required
                          maxLength={5000}
                          rows={2}
                          value={draftEvidence}
                          onChange={(event) => setDraftEvidence(event.target.value)}
                        />
                      </label>
                      <div className="mr-actions mr-wide">
                        <button
                          className="secondary-button"
                          type="submit"
                          disabled={
                            savingDraft ||
                            freshness?.fresh !== true ||
                            !draftPath ||
                            !draftBody.trim() ||
                            !draftEvidence.trim() ||
                            (draftScope !== 'file' && !draftLine) ||
                            (draftScope === 'range' && (!draftEndLine || Number(draftEndLine) <= Number(draftLine)))
                          }
                        >
                          {savingDraft
                            ? '保存中…'
                            : editingDraftId
                            ? '更新本地草稿'
                            : '保存本地草稿'}
                        </button>
                        {editingDraftId && (
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => {
                              setEditingDraftId(null);
                              setDraftBody('');
                              setDraftEvidence('');
                              setDraftLine('');
                              setDraftScope('line');
                              setDraftEndLine('');
                              setDraftCategory('problem');
                              setDraftSuggestion('');
                              setDraftResolved(false);
                            }}
                          >
                            取消编辑
                          </button>
                        )}
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => void exportDrafts()}
                        >
                          导出草稿 Markdown
                        </button>
                      </div>
                    </form>
                    {draftExport && (
                      <details className="report-preview">
                        <summary>草稿 Markdown · 可复制</summary>
                        <textarea
                          aria-label="评论草稿 Markdown"
                          value={draftExport}
                          readOnly
                          rows={8}
                        />
                      </details>
                    )}
                    {(review.commentDrafts ?? []).map((draft) => (
                      <div className="mr-draft-item" key={draft.id}>
                        <strong>
                          {draft.path}{draft.scope === 'file' ? ' · 文件级' : `:${draft.line}${draft.scope === 'range' ? `-${draft.endLine}` : ''} · ${draft.side === 'after' ? '新增行' : '删除行'}`}
                        </strong>
                        <span>
                          {draft.anchorStatus === 'pending' ? '待重新定位' : freshness?.fresh === false ? '待重核 · 旧版草稿' : '未发布 · 本地草稿'} · {commentCategoryLabel[draft.category ?? 'problem']} · {draft.resolved ? '已解决' : '未解决'}
                        </span>
                        {draft.anchorReason && <small>{draft.anchorReason}</small>}
                        <p>{draft.body}</p>
                        <p>人工依据：{draft.evidence}</p>
                        {draft.suggestion && <pre className="comment-suggestion"><code>{draft.suggestion}</code></pre>}
                        <div className="mr-actions">
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={freshness?.fresh !== true}
                            onClick={() => beginEditDraft(draft)}
                          >
                            编辑
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={freshness?.fresh !== true || draft.anchorStatus === 'pending'}
                            onClick={() => void copyDraft(draft)}
                          >
                            复制评论
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => void deleteDraft(draft)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {(review.gitlab || (snapshot.mode && snapshot.mode !== 'commits')) &&
                freshness?.fresh === false && (
                  <div className="stale-banner" role="status">
                    {review.gitlab
                      ? 'GitLab MR 版本已变化；此页仍显示旧快照。请从左侧重新导入 MR 后核对草稿和人工结论。'
                      : `当前${
                          snapshot.mode === 'staged' ? '暂存区' : '工作区'
                        }源码已变化；此页仍显示原快照。请从左侧重新打开变更后核对人工结论。`}
                    {freshness.reason && <span> {freshness.reason}</span>}
                  </div>
                )}
              {snapshot.files.length === 0 ? (
                <div className="empty-state">
                  <Icon name="check" size={32} />
                  <h2>这两个版本之间没有变更</h2>
                  <p>可以重新选择基线或目标版本。</p>
                </div>
              ) : (
                <div className="review-grid" ref={reviewGridRef} style={reviewGridStyle}>
                  <nav className="review-navigation" ref={navigationPanelRef}>
                    <div className="nav-tabs">
                      <button
                        className={navigation === 'files' ? 'selected' : ''}
                        onClick={() => setNavigation('files')}
                      >
                        变更文件 <span>{snapshot.files.length}</span>
                      </button>
                      <button
                        className={navigation === 'guide' ? 'selected' : ''}
                        onClick={() => setNavigation('guide')}
                      >
                        阅读路线
                      </button>
                    </div>
                    {navigation === 'files' && (
                      <div className="file-view-switch" role="group" aria-label="变更文件视图">
                        <button
                          type="button"
                          className={fileView === 'list' ? 'selected' : ''}
                          aria-pressed={fileView === 'list'}
                          onClick={() => setFileView('list')}
                        >
                          列表视图
                        </button>
                        <button
                          type="button"
                          className={fileView === 'tree' ? 'selected' : ''}
                          aria-pressed={fileView === 'tree'}
                          onClick={() => setFileView('tree')}
                        >
                          树形视图
                        </button>
                      </div>
                    )}
                    {navigation === 'files' && <div className="file-filters">
                      <input ref={fileSearchRef} aria-label="搜索变更文件" placeholder="搜索文件名或路径 · /" value={filters.query}
                        onChange={(event) => setFilters((value) => ({ ...value, query: event.target.value }))} />
                      <div className="file-filter-selects">
                        <select aria-label="按变更类型筛选" value={filters.change} onChange={(event) => setFilters((value) => ({ ...value, change: event.target.value as FileFilters['change'] }))}>
                          <option value="all">全部变更</option><option value="added">新增</option><option value="modified">修改</option><option value="deleted">删除</option><option value="renamed">重命名</option>
                        </select>
                        <select aria-label="按审查状态筛选" value={filters.status} onChange={(event) => setFilters((value) => ({ ...value, status: event.target.value as FileFilters['status'] }))}>
                          <option value="all">全部状态</option><option value="unreviewed">未审查</option><option value="unread">未阅读</option><option value="in_progress">审查中</option><option value="question">有疑问</option><option value="reviewed">已审查</option>
                        </select>
                        <select aria-label="按文件类型筛选" value={filters.category} onChange={(event) => setFilters((value) => ({ ...value, category: event.target.value as FileFilters['category'] }))}>
                          <option value="all">全部类型</option><option value="source">源码</option><option value="test">测试</option><option value="config">配置</option><option value="style">样式</option><option value="docs">文档</option><option value="lock">锁文件</option>
                        </select>
                      </div>
                      <div className="file-filter-flags">
                        <label><input type="checkbox" checked={filters.comments} onChange={(event) => setFilters((value) => ({ ...value, comments: event.target.checked }))} />有评论</label>
                        <label><input type="checkbox" checked={filters.pending} onChange={(event) => setFilters((value) => ({ ...value, pending: event.target.checked }))} />待确认</label>
                        <label><input type="checkbox" checked={filters.unavailable} onChange={(event) => setFilters((value) => ({ ...value, unavailable: event.target.checked }))} />无法分析</label>
                      </div>
                      <div className="file-review-counts">{freshness === null && (review.gitlab || snapshot.mode && snapshot.mode !== 'commits') ? '源码状态校验中…' : `已审查 ${statusCounts.reviewed} · 有疑问 ${statusCounts.question} · 未审查 ${statusCounts.unreviewed}`}</div>
                      <p className="file-count-note">按文件统计；hunk 审查、逐块理解和逐条判断分别记录。</p>
                      <button type="button" className="next-unreviewed" onClick={nextUnreviewedFile} disabled={!visibleFiles.some((item) => ['unread', 'in_progress'].includes(currentFileStatus(review, item, fileStatesFresh)))}>下一个未审查文件</button>
                    </div>}
                    <div className={`nav-content${navigation === 'files' && fileView === 'tree' ? ' tree-mode' : ''}${navigation === 'guide' ? ' guide-mode' : ''}`}>
                      {navigation === 'files' ? (
                        visibleFiles.length === 0 ? <p className="muted small">没有符合条件的文件。</p> : fileView === 'list' ? (
                          visibleFiles.map((item) => (
                            <FileNavItem
                              key={item.id}
                              item={item}
                              selected={selectedFile === item.id}
                              onSelect={chooseFile}
                              reviewStatus={currentFileStatus(review, item, fileStatesFresh)}
                              historicalStatus={freshness?.fresh === false ? review.fileStates?.[item.id]?.status : undefined}
                            />
                          ))
                        ) : (
                          <FileTree
                            key={snapshot.id}
                            files={visibleFiles}
                            selectedFile={selectedFile}
                            onSelect={chooseFile}
                            review={review}
                            fresh={fileStatesFresh}
                            stale={freshness?.fresh === false}
                          />
                        )
                      ) : review.guide ? (
                        <>
                          <p className="nav-caption">{review.commitContext ? '按功能查看 · 点击后列出文件和变更块' : '旧版阅读分组 · 重新生成后按功能整理'}</p>
                          <FeatureList review={review} selectedGroup={selectedGroup}
                            onGroup={chooseGroup} onChange={(_, sourceFile, change) => jumpToChange(sourceFile, change)}
                            onUnreviewed={(sourceFile, change) => { setSelectedGroup(-1); jumpToChange(sourceFile, change); }} />
                        </>
                      ) : (
                        <div className="nav-empty">
                          <Icon name="spark" size={22} />
                          <p>
                            生成导读后，
                            <br />
                            这里会出现阅读路线。
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="nav-footer">
                      显示 {visibleFiles.length}/{snapshot.files.length} 个文件 · {changes.length} 处变更
                    </div>
                    <button type="button" className="review-resizer left" aria-label="调整文件导航宽度，拖动或使用左右方向键"
                      onPointerDown={(event) => beginReviewPanelResize('left', event)}
                      onPointerMove={(event) => moveReviewPanelResize('left', event)}
                      onPointerUp={(event) => endReviewPanelResize('left', event)}
                      onPointerCancel={(event) => endReviewPanelResize('left', event)}
                      onLostPointerCapture={() => { resizeDrag.current = null; }}
                      onKeyDown={(event) => keyReviewPanelResize('left', event)} />
                  </nav>
                  <section className="code-section" ref={codeSectionRef} tabIndex={-1}>
                    <div className="code-heading">
                      <Icon name="file" size={16} />
                      <span title={file?.path ?? activeRef?.path}>
                        {file?.path ?? activeRef?.path ?? '选择一个文件'}
                      </span>
                      {!file && activeRef && (
                        <span className="context-tag">
                          相关片段 · {activeRef.side === 'before' ? '修改前' : '修改后'}
                        </span>
                      )}
                      {!showOneFile && (
                        <div className="diff-expand-controls" role="group" aria-label="文件内容展开状态">
                          <button type="button" title="展开全部文件" aria-label="展开全部文件" onClick={() => setCollapsedFiles(new Set())}>展开</button>
                          <button type="button" title="折叠全部文件" aria-label="折叠全部文件" onClick={() => setCollapsedFiles(new Set(visibleFiles.map((item) => item.id)))}>折叠</button>
                        </div>
                      )}
                      <div className="diff-layout-switch" role="group" aria-label="差异布局">
                        <button type="button" aria-pressed={diffLayout === 'side-by-side'}
                          onClick={() => setDiffLayout('side-by-side')}>并排</button>
                        <button type="button" aria-pressed={diffLayout === 'inline'}
                          onClick={() => setDiffLayout('inline')}>内联</button>
                      </div>
                      <details className="diff-options">
                        <summary aria-label="差异显示设置" title="差异显示设置">显示设置 ▾</summary>
                        <div className="diff-options-menu">
                          <label title="控制纯空白变更的差异高亮">
                            <input type="checkbox" checked={showWhitespaceChanges} onChange={(event) => setShowWhitespaceChanges(event.target.checked)} />
                            显示空白变更内容
                          </label>
                          <label>
                            <input type="checkbox" checked={showOneFile} onChange={(event) => setShowOneFile(event.target.checked)} />
                            一次显示一个文件
                          </label>
                        </div>
                      </details>
                    </div>
                    <div className="review-core-toolbar">
                      {navigation === 'guide' && group && <span className="feature-focus-label">已选功能：{group.title} · {group.changeIds.some((id) => id.includes(':hunk-')) ? '所属变更块以紫色边框标出' : '只有元数据变更，无文本高亮'}</span>}
                      <div className="review-core-navigation">
                        <button type="button" onClick={() => navigateFile(-1)} disabled={!visibleFiles.length} title="上一个文件 · Alt+↑">上一文件</button>
                        <button type="button" onClick={() => navigateFile(1)} disabled={!visibleFiles.length} title="下一个文件 · Alt+↓">下一文件</button>
                        <button type="button" onClick={() => navigateHunk(-1)} disabled={!visibleHunks.length} title="上一个变更块 · Alt+←">上一变更</button>
                        <button type="button" onClick={() => navigateHunk(1)} disabled={!visibleHunks.length} title="下一个变更块 · Alt+→">下一变更</button>
                        <button type="button" onClick={() => setShowFullFile((value) => !value)} disabled={!file || Boolean(file.issue)}>{showFullFile ? '折叠上下文' : '展开完整文件'}</button>
                      </div>
                      <div className="review-core-state">
                        <span className="hunk-range" title={visibleHunks[activeHunkIndex]?.change.label ?? ''}>{visibleHunks[activeHunkIndex]?.change.label ?? '无当前变更块'}</span>
                        <select aria-label="当前文件审查状态" value={file ? currentFileStatus(review, file, fileStatesFresh) : 'unread'} disabled={!file || !fileStatesFresh}
                          onChange={(event) => void updateFileStatus(event.target.value as FileStatus)}>
                          <option value="unread">未阅读</option><option value="in_progress">审查中</option><option value="question">有疑问</option><option value="reviewed">已审查</option>
                        </select>
                        <button type="button" onClick={openComment} disabled={!file || !fileStatesFresh || Boolean(file.issue)} title="当前位置创建评论 · Alt+C">评论当前位置</button>
                        {!review.gitlab && <details className="file-comment-panel" ref={commentSectionRef}>
                          <summary>当前文件评论 · {(review.localComments ?? []).filter((item) => item.fileId === file?.id && item.path === file?.path).length}</summary>
                          <div className="mr-panel-content">
                            <p>评论只保存在当前快照，不会发布到代码托管平台。先点击 diff 行，再选择“评论当前位置”。</p>
                            <button className="secondary-button" type="button" disabled={!file || !fileStatesFresh} onClick={() => {
                              if (!file) return;
                              setCommentTarget({ fileId: file.id, side: 'after', line: 0 });
                              setEditingLocalCommentId(null); setDraftScope('file'); setDraftEndLine('');
                              setDraftBody(''); setDraftEvidence('');
                            }}>评论当前文件</button>
                            {commentTarget && commentTarget.fileId === file?.id && <form className="mr-draft-form" onSubmit={(event) => void saveLocalComment(event)}>
                              <strong className="mr-wide">{file?.path}{draftScope === 'file' ? ' · 文件级' : `:${commentTarget.line} · ${commentTarget.side === 'before' ? '修改前' : '修改后'}`}</strong>
                              <label>位置类型
                                <select aria-label="本地评论位置类型" value={draftScope} onChange={(event) => {
                                  const scope = event.target.value as typeof draftScope;
                                  if (scope !== 'file' && commentTarget.line === 0 && file) {
                                    const first = firstPosition(file);
                                    if (!first) return;
                                    setCommentTarget({ fileId: file.id, side: first.side, line: first.line });
                                  }
                                  setDraftScope(scope); setDraftEndLine('');
                                }}><option value="line">单行</option><option value="range">多行</option><option value="file">文件级</option></select>
                              </label>
                              {draftScope !== 'file' && <>
                                <label>侧别
                                  <select aria-label="本地评论侧别" value={commentTarget.side} onChange={(event) => setCommentTarget((current) => current && ({ ...current, side: event.target.value as Side }))}>
                                    <option value="after">修改后</option><option value="before">修改前</option>
                                  </select>
                                </label>
                                <label>起始行号
                                  <input aria-label="本地评论起始行号" type="number" min="1" required value={commentTarget.line || ''} onChange={(event) => setCommentTarget((current) => current && ({ ...current, line: Number(event.target.value) }))} />
                                </label>
                              </>}
                              {draftScope === 'range' && <label>结束行号
                                <input aria-label="本地评论结束行号" type="number" min="1" required value={draftEndLine} onChange={(event) => setDraftEndLine(event.target.value)} />
                              </label>}
                              <label>评论类型
                                <select aria-label="本地评论类型" value={draftCategory} onChange={(event) => { const category = event.target.value as CommentCategory; setDraftCategory(category); if (category !== 'suggestion') setDraftSuggestion(''); }}>
                                  {Object.entries(commentCategoryLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                                </select>
                              </label>
                              <label>本地状态
                                <select aria-label="本地评论解决状态" value={draftResolved ? 'resolved' : 'open'} onChange={(event) => setDraftResolved(event.target.value === 'resolved')}>
                                  <option value="open">未解决</option><option value="resolved">已解决</option>
                                </select>
                              </label>
                              {draftCategory === 'suggestion' && <label className="mr-wide">修改建议代码块
                                <textarea aria-label="本地评论修改建议代码" maxLength={5000} rows={4} value={draftSuggestion} onChange={(event) => setDraftSuggestion(event.target.value)} />
                              </label>}
                              <label className="mr-wide">问题描述
                                <textarea ref={commentBodyRef} aria-label="本地评论问题描述" required maxLength={5000} rows={2} value={draftBody} onChange={(event) => setDraftBody(event.target.value)} />
                              </label>
                              <label className="mr-wide">人工验证依据
                                <textarea aria-label="本地评论人工依据" required maxLength={5000} rows={2} value={draftEvidence} onChange={(event) => setDraftEvidence(event.target.value)} />
                              </label>
                              <div className="mr-actions mr-wide">
                                <button className="secondary-button" type="submit" disabled={savingLocalComment || !fileStatesFresh || !draftBody.trim() || !draftEvidence.trim() ||
                                  (draftScope !== 'file' && commentTarget.line < 1) || (draftScope === 'range' && (!draftEndLine || Number(draftEndLine) <= commentTarget.line))}>{savingLocalComment ? '保存中…' : editingLocalCommentId ? '更新本地评论' : '保存本地评论'}</button>
                                <button className="secondary-button" type="button" onClick={() => { setCommentTarget(null); setEditingLocalCommentId(null); setDraftBody(''); setDraftEvidence(''); }}>取消</button>
                              </div>
                            </form>}
                            {(review.localComments ?? []).filter((item) => item.fileId === file?.id && item.path === file?.path).map((comment) => <div className="mr-draft-item" key={comment.id}>
                              <strong>{comment.path}{comment.scope === 'file' ? ' · 文件级' : `:${comment.line}${comment.scope === 'range' ? `-${comment.endLine}` : ''} · ${comment.side === 'before' ? '修改前' : '修改后'}`}</strong>
                              <span>{comment.anchorStatus === 'pending' ? '待重新定位' : fileStatesFresh ? '未发布 · 本地评论' : '待重核 · 旧快照评论'} · {commentCategoryLabel[comment.category ?? 'problem']} · {comment.resolved ? '已解决' : '未解决'}</span>
                              {comment.anchorReason && <small>{comment.anchorReason}</small>}
                              <p>{comment.body}</p><p>人工依据：{comment.evidence}</p>
                              {comment.suggestion && <pre className="comment-suggestion"><code>{comment.suggestion}</code></pre>}
                              <div className="mr-actions">
                                <button className="secondary-button" type="button" disabled={comment.anchorStatus === 'pending'} onClick={() => { if (file) { if (commentSectionRef.current) commentSectionRef.current.open = false; comment.scope === 'file' ? chooseFile(file.id) : jumpTo(file, comment.side, comment.line); } }}>定位</button>
                                <button className="secondary-button" type="button" disabled={!fileStatesFresh || !file} onClick={() => { if (file) beginEditLocalComment(comment, file); }}>编辑</button>
                                <button className="secondary-button" type="button" onClick={() => void deleteLocalComment(comment)}>删除</button>
                              </div>
                            </div>)}
                          </div>
                        </details>}
                      </div>
                    </div>
                    <div className="symbol-pick-bar">
                      {snapshot.mode && snapshot.mode !== 'commits'
                        ? <span>符号影响链支持两次提交或 GitLab MR 固定版本</span>
                        : symbolPick
                          ? <><span>已选符号：<strong>{symbolPick.name}</strong> · {symbolPick.path}:L{symbolPick.line}</span>
                            <button type="button" disabled={symbolImpactLoading} onClick={() => void loadSymbolImpact(symbolPick)}>
                              {symbolImpactLoading ? '正在分析…' : '查看影响链'}
                            </button></>
                          : <span>在源码中选中完整的 JS/TS 标识符，再点击“查看影响链”。</span>}
                      {symbolImpact && <button type="button" onClick={() => setSymbolImpactOpen(true)}>返回影响链</button>}
                      {(!snapshot.mode || snapshot.mode === 'commits') && (
                        <span className="symbol-pick-help">精确关系是固定源码中的符号引用；静态或文本候选仍需人工核对。两者均不证明运行时可达。</span>
                      )}
                      {symbolImpactError && <span className="symbol-pick-error" role="alert">无法查看影响链：{symbolImpactError}</span>}
                    </div>
                    {file && showOneFile && (
                      <div className="code-versions">
                        <span>修改前 · {short(snapshot.base)}</span>
                        <span>修改后 · {short(snapshot.target)}</span>
                      </div>
                    )}
                    {file?.status.startsWith('R') && showOneFile && (
                      <div className="rename-note">
                        重命名：{file.oldPath} → {file.path}
                      </div>
                    )}
                    {!showOneFile ? (
                      <div className="all-files-scroll" ref={allFilesScroll}>
                        {visibleFiles.map((item) => (
                          <FileDiffCard
                            key={item.id}
                            file={item}
                            base={snapshot.base}
                            target={snapshot.target}
                            activeRef={selectedFile === item.id ? activeRef : null}
                            diffLayout={diffLayout}
                            showWhitespaceChanges={showWhitespaceChanges}
                            showFullFile={showFullFile}
                            jump={selectedFile === item.id ? jump : null}
                            onPosition={(side, line) => recordScrollPosition(item, side, line)}
                            expanded={!collapsedFiles.has(item.id)}
                            scrollRoot={allFilesScroll}
                            onToggle={() => setCollapsedFiles((current) => {
                              const next = new Set(current);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })}
                            onLine={(side, line) => chooseLine(side, line, item)}
                            comments={commentMarkers(review, item)}
                            featureChangeIds={focusedChangeIds}
                            onSymbol={selectSymbol}
                          />
                        ))}
                      </div>
                    ) : file && !file.issue && !showWhitespaceChanges ? (
                      <StaticDiffPanel file={file} activeRef={activeRef} onLine={chooseLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} showFullFile={showFullFile} jump={jump} onPosition={(side, line) => recordScrollPosition(file, side, line)} comments={commentMarkers(review, file)} featureChangeIds={focusedChangeIds} onSymbol={selectSymbol} />
                    ) : (
                      <CodePanel file={file} activeRef={activeRef} onLine={chooseLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} showFullFile={showFullFile} jump={jump} onPosition={(side, line) => { if (file) recordScrollPosition(file, side, line); }} comments={file ? commentMarkers(review, file) : []} featureChangeIds={focusedChangeIds} onSymbol={selectSymbol} />
                    )}
                    <div className="code-footer">
                      <span>只读源码</span>
                      <span>
                        {activeRef
                          ? `${activeRef.label} · L${activeRef.startLine}–${activeRef.endLine}`
                          : '点击代码行，定位关联导读'}
                      </span>
                    </div>
                  </section>
                  <aside className="guide-panel" ref={guidePanelRef}>
                    <button type="button" className="review-resizer right" aria-label="调整 AI 导读宽度，拖动或使用左右方向键"
                      onPointerDown={(event) => beginReviewPanelResize('right', event)}
                      onPointerMove={(event) => moveReviewPanelResize('right', event)}
                      onPointerUp={(event) => endReviewPanelResize('right', event)}
                      onPointerCancel={(event) => endReviewPanelResize('right', event)}
                      onLostPointerCapture={() => { resizeDrag.current = null; }}
                      onKeyDown={(event) => keyReviewPanelResize('right', event)} />
                    <div className="panel-heading">
                      <span>
                        <Icon name="spark" size={17} />
                        AI 导读
                      </span>
                      <span className="codex-status">
                        <span className={`status-dot ${status?.subscription ? 'online' : ''}`} />
                        <span>{status ? (status.subscription ? 'Codex 已连接' : 'Codex 未就绪') : '连接中…'}</span>
                        <button type="button" className="icon-button" aria-label="刷新 Codex 状态" onClick={() => {
                          void api<CodexStatus>('/api/status')
                            .then(setStatus)
                            .catch((error) => setError(message(error)));
                        }}>↻</button>
                      </span>
                    </div>
                    <div className="guide-scroll">
                      <div className="generate-block">
                        <fieldset className="v8-generation-choice" disabled={busy}>
                          <legend>生成解释的方式</legend>
                          <label><input type="radio" name="hunk-mode" checked={hunkMode === 'all'}
                            onChange={() => setHunkMode('all')} />整份生成：阅读路线完成后继续逐块生成，等待和额度开销更多</label>
                          <label><input type="radio" name="hunk-mode" checked={hunkMode === 'on_demand'}
                            onChange={() => setHunkMode('on_demand')} />逐块按需：先生成阅读路线，之后选择具体变更再生成解释</label>
                        </fieldset>
                        <button
                          className="generate-button"
                          disabled={busy || !status?.subscription || !hunkMode}
                          onClick={() => void generate()}
                        >
                          <Icon name="spark" size={16} />
                          {busy ? '任务进行中…' : review.guide ? '重新生成导读' : '生成阅读路线'}
                        </button>
                        <p>
                          {status?.subscription
                            ? '使用你的 Codex 额度，将当前源码上下文发送至 Codex。'
                            : status?.message ?? '正在检查 Codex 登录…'}
                        </p>
                        {review.guide && (
                          <>
                            <button
                              className="secondary-button report-button"
                              onClick={() => void exportReport()}
                            >
                              导出当前审查记录（Markdown）
                            </button>
                            <p className="report-scope">报告会列出未核实判断和未分析变更（如有）；文件审查、hunk 审查及逐块理解状态仍在页面单独查看。审查未完成时也可导出，导出不代表通过。</p>
                          </>
                        )}
                        {reportPreview?.reviewId === snapshot.id && (
                          <details className="report-preview" open>
                            <summary>报告 Markdown · 可复制保存</summary>
                            <textarea
                              aria-label="审查报告 Markdown"
                              value={reportPreview.markdown}
                              readOnly
                              rows={9}
                            />
                          </details>
                        )}
                      </div>
                      {review.guide && <section className="feature-overview" aria-label="本次按功能改了什么">
                        <h2>本次按功能改了什么</h2>
                        <p className="guide-overview">{review.guide.overview}</p>
                        <div className="feature-overview-counts">
                          {review.guide.groups.length} 个{review.commitContext ? '功能或变更主题' : '阅读分组'} · 已归类 {review.guide.groups.reduce((count, item) => count + item.changeIds.length, 0)}/{changes.length} 处变更
                          {' · '}待人工核对 {review.guide.unreviewed.length} 处
                        </div>
                        <p className="feature-count-note">已归类只表示进入阅读分组，不等于逐块解释或人工核实。</p>
                        <FeatureList review={review} selectedGroup={selectedGroup}
                          onGroup={(index) => { setNavigation('guide'); chooseGroup(index); }}
                          onChange={chooseFeatureChange}
                          onUnreviewed={(sourceFile, change) => {
                            setNavigation('guide'); setSelectedGroup(-1); jumpToChange(sourceFile, change);
                          }} />
                      </section>}
                      {review.guide && <V8ReviewPanel key={snapshot.id} review={review}
                        changeId={readingPosition?.changeId} fresh={fileStatesFresh} stale={freshness?.fresh === false} busy={busy}
                        canGenerate={Boolean(status?.subscription)}
                        onGenerateHunk={(changeId) => void generateHunk(changeId)}
                        onUnderstanding={updateHunkUnderstanding}
                        onChange={(changeId) => {
                          const selected = snapshot.files.find((item) => item.changes.some((change) => change.id === changeId));
                          const change = selected?.changes.find((item) => item.id === changeId);
                          if (selected && change) {
                            // 矩阵跳转同步既有功能高亮；未分析项不应继续显示上一功能的范围。
                            setSelectedGroup(review.guide?.groups.findIndex((item) => item.changeIds.includes(changeId)) ?? -1);
                            jumpToChange(selected, change);
                            focusCodeAfterMatrix();
                          }
                        }}
                        onMatrixClose={focusCodeAfterMatrix}
                        onSource={showRef} />}
                      {review.guide ? (
                        <>
                          {review.commitContext && <details className="commit-context">
                            <summary>参考提交描述 · {review.commitContext.messages.length} 条（仅作为作者意图线索）</summary>
                            {review.commitContext.note && <p>{review.commitContext.note}</p>}
                            {review.commitContext.messages.map((item) => <p key={item.oid}><code>{short(item.oid)}</code> {item.subject || '（空提交描述）'}</p>)}
                          </details>}
                          {(snapshot.requirements?.length ?? 0) > 0 && (
                            <section className="detail-section requirement-section">
                              <h3>需求对照</h3>
                              {snapshot.requirements!.map((requirement) => {
                                const link = review.guide?.requirementLinks?.find(
                                  (item) => item.requirementId === requirement.id,
                                );
                                return (
                                  <div className="requirement-item" key={requirement.id}>
                                    <strong>
                                      {requirement.kind === 'preserve' ? '不得改变' : '本次需求'} ·{' '}
                                      {requirement.text}
                                    </strong>
                                    {link ? (
                                      <>
                                        {renderClaim(`requirement:${requirement.id}`)}
                                        <small>
                                          对应 {link.changeIds.length} 处变更
                                          {link.changeIds.length === 0 ? ' · 待人工核对' : ''}
                                        </small>
                                      </>
                                    ) : (
                                      <p>旧版导读未包含需求对照，请重新生成。</p>
                                    )}
                                  </div>
                                );
                              })}
                              {review.guide.requirementLinks &&
                                (() => {
                                  const mapped = new Set(
                                    review.guide.requirementLinks.flatMap((item) => item.changeIds),
                                  );
                                  const missing = changes.filter((item) => !mapped.has(item.id));
                                  return (
                                    missing.length > 0 && (
                                      <p className="unmapped-note">
                                        {missing.length}{' '}
                                        处变更尚未对应输入的需求，需要人工确认范围。
                                      </p>
                                    )
                                  );
                                })()}
                            </section>
                          )}
                          {group && (
                            <div className="group-detail">
                              <div className="section-eyebrow">
                                {String(selectedGroup + 1).padStart(2, '0')} / 阅读分组
                              </div>
                              <h2>{group.title}</h2>
                              {snapshot.refs.some(
                                (ref) =>
                                  ref.role === 'reference' &&
                                  ref.relatedChangeIds?.some((id) => group.changeIds.includes(id)),
                              ) && (
                                <section className="detail-section static-reference-section">
                                  <h3>跨文件静态引用</h3>
                                  {snapshot.refs
                                    .filter(
                                      (ref) =>
                                        ref.role === 'reference' &&
                                        ref.relatedChangeIds?.some((id) =>
                                          group.changeIds.includes(id),
                                        ),
                                    )
                                    .map((ref) => (
                                      <button
                                        key={ref.id}
                                        className="ref-link"
                                        onClick={() => showRef(ref)}
                                        title={ref.label}
                                      >
                                        {ref.side === 'before' ? '前' : '后'} · {basename(ref.path)}
                                        :{ref.startLine} · {ref.label}
                                      </button>
                                    ))}
                                  <p>仅证明已载入源码中的符号引用，运行时路径仍需人工核对。</p>
                                </section>
                              )}
                              <div className="behavior before">
                                <h3>
                                  <span />
                                  修改前
                                </h3>
                                {renderClaim(`group:${selectedGroup}:before`)}
                              </div>
                              <div className="behavior after">
                                <h3>
                                  <span />
                                  修改后
                                </h3>
                                {renderClaim(`group:${selectedGroup}:after`)}
                              </div>
                              {(review.guide.flowSteps?.filter(
                                (step) => step.groupIndex === selectedGroup,
                              ).length ?? 0) > 0 && (
                                <section className="detail-section flow-section">
                                  <h3>业务流程</h3>
                                  {review.guide
                                    .flowSteps!.filter((step) => step.groupIndex === selectedGroup)
                                    .map((step) => ({
                                      step,
                                      index: review.guide!.flowSteps!.indexOf(step),
                                    }))
                                    .map(({ step, index }) => (
                                      <div className="flow-step" key={index}>
                                        <span>{step.stage}</span>
                                        {renderClaim(`flow:${index}`)}
                                      </div>
                                    ))}
                                </section>
                              )}
                              {group.notes.length > 0 && (
                                <section className="detail-section">
                                  <h3>关键规则与失败路径</h3>
                                  {group.notes.map((statement, index) => (
                                    <div key={index}>
                                      {renderClaim(`group:${selectedGroup}:note:${index}`)}
                                    </div>
                                  ))}
                                </section>
                              )}
                              {group.questions.length > 0 && (
                                <section className="detail-section">
                                  <h3>需要人工核对</h3>
                                  <ul className="question-list">
                                    {group.questions.map((item, index) => (
                                      <li key={index}>{item}</li>
                                    ))}
                                  </ul>
                                </section>
                              )}
                            </div>
                          )}
                          <p className="evidence-disclaimer">
                            引用和变更覆盖已校验；逐条判断以人工记录为准。
                          </p>
                        </>
                      ) : (
                        <div className="guide-placeholder">
                          <div className="placeholder-symbol">
                            <Icon name="spark" size={25} />
                          </div>
                          <h3>先理解这次修改</h3>
                          <p>
                            导读会解释修改前后的行为、关键规则和需要核实的问题。每条源码依据都能点击查看。
                          </p>
                          <div className="placeholder-line" />
                          <div className="placeholder-line short" />
                          <div className="placeholder-line medium" />
                        </div>
                      )}
                      <details className="coverage-details">
                        <summary>
                          上下文范围与限制{' '}
                          <span>
                            {snapshot.gaps.length + (review.guide?.limitations.length ?? 0)}
                          </span>
                        </summary>
                        {[...snapshot.gaps, ...(review.guide?.limitations ?? [])].map(
                          (gap, index) => (
                            <p key={index}>{gap}</p>
                          ),
                        )}
                      </details>
                    </div>
                  </aside>
                  {symbolImpact && <SymbolImpactPanel key={`${symbolImpact.snapshotId}:${symbolImpact.selected.locations[0]?.blobOid}:${symbolImpact.selected.locations[0]?.line}:${symbolImpact.selected.locations[0]?.column}`}
                    impact={symbolImpact} review={review}
                    open={symbolImpactOpen} loading={symbolImpactLoading}
                    onClose={() => setSymbolImpactOpen(false)}
                    onNavigate={(location, fileOnly) => void navigateImpactLocation(location, fileOnly)}
                    onExpand={(location) => void loadSymbolImpact({ ...location,
                      startColumn: location.column, name: '' }, true)} />}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
