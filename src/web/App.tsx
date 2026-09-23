import { useEffect, useRef, useState } from 'react';
import type {
  Answer,
  ClaimReviewState,
  CodexStatus,
  CommentDraft,
  ReviewSummary,
  ReviewFile,
  RepositoryVersionOption,
  SavedReview,
  Side,
  SnapshotMode,
  SourceRef,
  Statement,
  TaskStatus,
  VerificationOptions,
  VerificationCase,
  VerificationTaskStatus,
} from '../shared/types.js';
import { listClaims, type ReviewClaim } from '../shared/claims.js';
import { api } from './api.js';
import { CodePanel, StaticDiffPanel } from './CodePanel.js';

const short = (value: string) => value.slice(0, 8);
const basename = (value: string) => value.split('/').filter(Boolean).at(-1) ?? value;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Icon({
  name,
  size = 18,
}: {
  name: 'branch' | 'spark' | 'file' | 'folder' | 'arrow' | 'clock' | 'check' | 'close';
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

function AnswerView({
  answer,
  refs,
  onRef,
}: {
  answer: Answer;
  refs: SourceRef[];
  onRef: (ref: SourceRef) => void;
}) {
  return (
    <>
      {answer.statements.map((statement, index) => (
        <EvidenceStatement key={index} statement={statement} refs={refs} onRef={onRef} />
      ))}
      {answer.openQuestions.length > 0 && (
        <ul className="question-list">
          {answer.openQuestions.map((question, index) => (
            <li key={index}>{question}</li>
          ))}
        </ul>
      )}
    </>
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
}: {
  item: ReviewFile;
  selected: boolean;
  onSelect: (id: string) => void;
  treeDepth?: number;
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
}: {
  files: ReviewFile[];
  selectedFile: string | null;
  onSelect: (id: string) => void;
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
              <CodePanel file={file} activeRef={activeRef} onLine={onLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} />
            ) : (
              <StaticDiffPanel file={file} activeRef={activeRef} onLine={onLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} />
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
  const [review, setReview] = useState<SavedReview | null>(null);
  const reviewId = useRef<string | undefined>();
  reviewId.current = review?.snapshot.id;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState(0);
  const [activeRef, setActiveRef] = useState<SourceRef | null>(null);
  const [navigation, setNavigation] = useState<'files' | 'guide'>('files');
  const [fileView, setFileView] = useState<'list' | 'tree'>('list');
  const [diffLayout, setDiffLayout] = useState<'side-by-side' | 'inline'>('side-by-side');
  const [showWhitespaceChanges, setShowWhitespaceChanges] = useState(true);
  const [showOneFile, setShowOneFile] = useState(true);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const allFilesScroll = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [task, setTask] = useState<TaskStatus | null>(null);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState(false);
  const [noteFeedback, setNoteFeedback] = useState('');
  const [freshness, setFreshness] = useState<{ fresh: boolean; reason?: string } | null>(null);
  const [reviewStatus, setReviewStatus] = useState<
    'unread' | 'understood' | 'question' | 'verified'
  >('unread');
  const [reviewEvidence, setReviewEvidence] = useState('');
  const [savingReviewState, setSavingReviewState] = useState(false);
  const [reportPreview, setReportPreview] = useState<{ reviewId: string; markdown: string } | null>(
    null,
  );
  const [verificationOptions, setVerificationOptions] = useState<VerificationOptions | null>(null);
  const [verificationOptionError, setVerificationOptionError] = useState('');
  const [verificationCaseId, setVerificationCaseId] = useState('');
  const [verificationScript, setVerificationScript] = useState('');
  const [verificationTrigger, setVerificationTrigger] = useState('');
  const [verificationExpected, setVerificationExpected] = useState('');
  const [verificationTask, setVerificationTask] = useState<VerificationTaskStatus | null>(null);
  const [draftPath, setDraftPath] = useState('');
  const [draftSide, setDraftSide] = useState<Side>('after');
  const [draftLine, setDraftLine] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftEvidence, setDraftEvidence] = useState('');
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftExport, setDraftExport] = useState<string | null>(null);
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
      })
      .catch((error) => {
        if (alive) setError(message(error));
      });
    return () => {
      alive = false;
    };
  }, []);

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
            setReview(updated);
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

  useEffect(() => {
    if (!review?.guide || !review.guideFingerprint) {
      setVerificationOptions(null);
      return;
    }
    let alive = true;
    setVerificationOptions(null);
    setVerificationOptionError('');
    setVerificationCaseId('');
    setVerificationScript('');
    setVerificationTrigger('');
    setVerificationExpected('');
    void api<VerificationOptions>(`/api/reviews/${review.snapshot.id}/verification-options`)
      .then((value) => {
        if (alive) setVerificationOptions(value);
      })
      .catch((error) => {
        if (alive) setVerificationOptionError(message(error));
      });
    return () => {
      alive = false;
    };
  }, [review?.snapshot.id, review?.guideFingerprint]);

  useEffect(() => {
    if (verificationTask?.state !== 'running') return;
    let alive = true;
    const timer = setInterval(() => {
      void api<VerificationTaskStatus>(`/api/verifications/${verificationTask.id}`)
        .then(async (next) => {
          if (!alive) return;
          if (next.state === 'completed') {
            clearInterval(timer);
            try {
              const updated = await api<SavedReview>(`/api/reviews/${next.reviewId}`);
              if (alive && reviewId.current === next.reviewId) {
                setReview(updated);
                setReportPreview(null);
              }
            } catch (error) {
              if (alive) setError(message(error));
            }
          } else if (next.state === 'failed') {
            clearInterval(timer);
            setError(next.error ?? '隔离验证失败。');
          }
          if (alive) setVerificationTask(next);
        })
        .catch((error) => {
          if (alive) setError(message(error));
        });
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [verificationTask?.id, verificationTask?.state]);

  const snapshot = review?.snapshot;
  useEffect(() => {
    // 文件 id 在每个快照内从 file-1 重新编号，切换快照时不能沿用折叠状态。
    setCollapsedFiles(new Set());
  }, [snapshot?.id]);
  const file = snapshot?.files.find((item) => item.id === selectedFile) ?? null;
  const group = review?.guide?.groups[selectedGroup];
  const busy = requesting || task?.state === 'running';
  const changes = snapshot?.files.flatMap((item) => item.changes) ?? [];
  const claims = review?.guide ? listClaims(review.guide) : [];
  const isCaseUnresolved = (item: VerificationCase) => {
    if (!item.id.startsWith('claim:')) return true;
    const state = review?.claimStates?.[item.id.slice('claim:'.length)];
    return state?.status !== 'confirmed' || state.guideFingerprint !== review?.guideFingerprint;
  };
  const claimByKey = new Map(claims.map((claim) => [claim.key, claim]));
  const noteKey = file ? `file:${file.id}` : 'overview';
  const draftKey = `${snapshot?.id}:${noteKey}`;
  const note = drafts[draftKey] ?? review?.notes[noteKey] ?? '';
  const noteChanged = note !== (review?.notes[noteKey] ?? '');
  const selectedHash = review?.groupHashes?.[selectedGroup];
  const savedState = selectedHash ? review?.reviewStates?.[selectedHash] : undefined;
  const groupStatusLabel = (index: number) => {
    const status = review?.reviewStates?.[review.groupHashes?.[index] ?? '']?.status;
    const label =
      status === 'verified'
        ? '已核实'
        : status === 'understood'
        ? '已理解'
        : status === 'question'
        ? '有疑问'
        : '未阅读';
    if (
      (review?.gitlab || (snapshot?.mode && snapshot.mode !== 'commits')) &&
      status &&
      freshness === null
    )
      return `校验中 · 原${label}`;
    return freshness?.fresh === false && status ? `待重核 · 原${label}` : label;
  };

  useEffect(() => {
    setReviewStatus(savedState?.status ?? 'unread');
    setReviewEvidence(savedState?.evidence ?? '');
  }, [selectedHash, savedState?.status, savedState?.evidence]);

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
    setSelectedFile(value.snapshot.files[0]?.id ?? null);
    setActiveRef(null);
    setSelectedGroup(0);
    setNavigation(value.guide ? 'guide' : 'files');
    setFileView('list');
    setQuestion('');
    setNoteFeedback('');
    setReportPreview(null);
    setDraftPath(
      value.gitlab?.files.find((item) => item.addedLines.length || item.deletedLines.length)
        ?.path ?? '',
    );
    setDraftSide('after');
    setDraftLine('');
    setDraftBody('');
    setDraftEvidence('');
    setEditingDraftId(null);
    setDraftExport(null);
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
  async function createReview(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError('');
    const request = ++loadCounter.current;
    try {
      const value = await api<SavedReview>(
        sourceKind === 'gitlab' ? '/api/gitlab/import' : '/api/snapshots',
        {
          method: 'POST',
          body:
            sourceKind === 'gitlab'
              ? { repo, url: mrUrl, requirements, preserve }
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
      setHistory(await api<ReviewSummary[]>('/api/reviews'));
    } catch (error) {
      setError(message(error));
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
  async function saveReviewState() {
    if (!review || !selectedHash) return;
    setSavingReviewState(true);
    setError('');
    try {
      const updated = await api<SavedReview>(`/api/reviews/${review.snapshot.id}/states`, {
        method: 'PUT',
        body: {
          groupIndex: selectedGroup,
          guideHash: selectedHash,
          status: reviewStatus,
          evidence: reviewEvidence,
        },
      });
      setReview(updated);
      setReportPreview(null);
    } catch (error) {
      setError(message(error));
    } finally {
      setSavingReviewState(false);
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
      setReview((current) => (current?.snapshot.id === savingId ? updated : current));
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
    setSavingDraft(true);
    setError('');
    try {
      const updated = await api<SavedReview>(
        editingDraftId
          ? `/api/reviews/${snapshot.id}/drafts/${editingDraftId}`
          : `/api/reviews/${snapshot.id}/drafts`,
        {
          method: editingDraftId ? 'PUT' : 'POST',
          body: editingDraftId
            ? { body: draftBody, evidence: draftEvidence }
            : {
                path: draftPath,
                side: draftSide,
                line: Number(draftLine),
                body: draftBody,
                evidence: draftEvidence,
              },
        },
      );
      setReview(updated);
      setDraftBody('');
      setDraftEvidence('');
      setDraftLine('');
      setEditingDraftId(null);
      setDraftExport(null);
      setReportPreview(null);
    } catch (error) {
      setError(message(error));
    } finally {
      setSavingDraft(false);
    }
  }
  async function deleteDraft(draft: CommentDraft) {
    if (!snapshot?.id) return;
    setError('');
    try {
      const updated = await api<SavedReview>(`/api/reviews/${snapshot.id}/drafts/${draft.id}`, {
        method: 'DELETE',
      });
      setReview(updated);
      setDraftExport(null);
      setReportPreview(null);
      if (editingDraftId === draft.id) setEditingDraftId(null);
    } catch (error) {
      setError(message(error));
    }
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
      await navigator.clipboard.writeText(`${draft.body}\n\n人工依据：${draft.evidence}`);
    } catch (error) {
      setError(message(error));
    }
  }
  async function startVerification() {
    if (!review?.guideFingerprint || !snapshot || !verificationOptions?.available) return;
    setError('');
    try {
      const started = await api<VerificationTaskStatus>(
        `/api/reviews/${snapshot.id}/verifications`,
        {
          method: 'POST',
          body: {
            caseId: verificationCaseId,
            scriptName: verificationScript,
            trigger: verificationTrigger,
            expected: verificationExpected,
            guideFingerprint: review.guideFingerprint,
          },
        },
      );
      setVerificationTask(started);
    } catch (error) {
      setError(message(error));
    }
  }
  async function generate() {
    if (!snapshot || busy) return;
    setRequesting(true);
    setError('');
    try {
      setTask(await api<TaskStatus>(`/api/reviews/${snapshot.id}/guide`, { method: 'POST' }));
    } catch (error) {
      setError(message(error));
    } finally {
      setRequesting(false);
    }
  }
  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!snapshot || !question || busy) return;
    setRequesting(true);
    setError('');
    try {
      setTask(
        await api<TaskStatus>(`/api/reviews/${snapshot.id}/questions`, {
          method: 'POST',
          body: { groupIndex: selectedGroup, question },
        }),
      );
      setQuestion('');
    } catch (error) {
      setError(message(error));
    } finally {
      setRequesting(false);
    }
  }
  async function saveNote() {
    if (!snapshot) return;
    const savingId = snapshot.id;
    const savingKey = noteKey;
    const savingText = note;
    setSavingNote(true);
    setNoteFeedback('');
    try {
      await api(`/api/reviews/${savingId}/notes`, {
        method: 'PUT',
        body: { key: savingKey, text: savingText },
      });
      setReview((current) =>
        current?.snapshot.id === savingId
          ? { ...current, notes: { ...current.notes, [savingKey]: savingText } }
          : current,
      );
      setReportPreview(null);
      setNoteFeedback('已保存');
    } catch (error) {
      setError(message(error));
    } finally {
      setSavingNote(false);
    }
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
    setSelectedFile(id);
    setActiveRef(null);
    setNoteFeedback('');
  }
  function showRef(ref: SourceRef) {
    if (!snapshot) return;
    const matching = snapshot.files.find((item) =>
      ref.side === 'before' ? item.oldPath === ref.path : item.path === ref.path,
    );
    setSelectedFile(matching?.id ?? null);
    setActiveRef(ref);
    setNoteFeedback('');
  }
  function chooseGroup(index: number) {
    setSelectedGroup(index);
    const firstChange = changes.find((change) =>
      review?.guide?.groups[index].changeIds.includes(change.id),
    );
    if (firstChange) {
      setSelectedFile(firstChange.fileId);
      setActiveRef(null);
    }
    setNoteFeedback('');
  }
  function chooseLine(side: Side, line: number, sourceFile: ReviewFile | null = file) {
    if (!sourceFile || !snapshot) return;
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
    if (ref) {
      setActiveRef(ref);
      const index = review?.guide?.groups.findIndex((group) =>
        group.changeIds.some((id) =>
          sourceFile.changes.some((change) => change.id === id && change.refIds.includes(ref.id)),
        ),
      );
      if (index !== undefined && index >= 0) setSelectedGroup(index);
    }
  }

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

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Diff Wingman 首页">
          <span className="brand-mark">
            <Icon name="branch" size={22} />
          </span>
          <span>
            Diff<span className="brand-light"> Wingman</span>
          </span>
          <span className="version-tag">v0.0.5</span>
        </a>
        <div className="header-status">
          <span className="local-tag">LOCAL WORKSPACE</span>
          <span className={`status-dot ${status?.subscription ? 'online' : ''}`} />
          <span>
            {status ? (status.subscription ? 'Codex 已连接' : 'Codex 未就绪') : '连接中…'}
          </span>
          <button
            className="icon-button"
            aria-label="刷新 Codex 状态"
            onClick={() => {
              void api<CodexStatus>('/api/status')
                .then(setStatus)
                .catch((error) => setError(message(error)));
            }}
          >
            ↻
          </button>
        </div>
      </header>
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <Icon name="branch" />
            <span>建立审查快照</span>
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
                onChange={(event) => setSourceKind(event.target.value as 'local' | 'gitlab')}
              >
                <option value="local">本地 Git 版本</option>
                <option value="gitlab">GitLab MR（只读）</option>
              </select>
            </label>
            {sourceKind === 'gitlab' ? (
              <label>
                GitLab MR 链接
                <input
                  required
                  type="url"
                  value={mrUrl}
                  onChange={(event) => setMrUrl(event.target.value)}
                  placeholder="https://gitlab.example.com/group/project/-/merge_requests/1"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
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
              history.map((item) => (
                <button
                  key={item.id}
                  className={`history-item ${snapshot?.id === item.id ? 'active' : ''}`}
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
              ))
            ) : (
              <p className="muted small">打开的快照会保存在本机。</p>
            )}
          </div>
          <div className="sidebar-footer">
            <span className="status-dot online" />
            源码只读 · 笔记本地保存
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
                    点击证据、追问细节，
                    <br />
                    留下自己的审查笔记。
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
                  <div className="eyebrow">
                    REVIEW SNAPSHOT <span>{snapshot.id.slice(0, 6)}</span>
                  </div>
                  <h1>
                    {basename(snapshot.repo)} <span className="snapshot-badge">固定快照</span>
                  </h1>
                  <p title={snapshot.repo}>{snapshot.repo}</p>
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
              {review.gitlab && (
                <details className="mr-panel">
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
                          disabled={Boolean(editingDraftId)}
                          onChange={(event) => {
                            setDraftPath(event.target.value);
                            setDraftLine('');
                          }}
                        >
                          <option value="">选择变更文件</option>
                          {review.gitlab.files
                            .filter((item) => item.addedLines.length || item.deletedLines.length)
                            .map((item) => (
                              <option key={item.path} value={item.path}>
                                {item.path}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        侧别
                        <select
                          aria-label="草稿侧别"
                          value={draftSide}
                          disabled={Boolean(editingDraftId)}
                          onChange={(event) => {
                            setDraftSide(event.target.value as Side);
                            setDraftLine('');
                          }}
                        >
                          <option value="after">新增行</option>
                          <option value="before">删除行</option>
                        </select>
                      </label>
                      <label>
                        行号
                        <input
                          aria-label="草稿行号"
                          type="number"
                          min="1"
                          required
                          value={draftLine}
                          disabled={Boolean(editingDraftId)}
                          onChange={(event) => setDraftLine(event.target.value)}
                        />
                      </label>
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
                            (!editingDraftId && !draftLine)
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
                          {draft.path}:{draft.line} · {draft.side === 'after' ? '新增行' : '删除行'}
                        </strong>
                        <span>
                          {freshness?.fresh === false ? '待重核 · 旧版草稿' : '未发布 · 本地草稿'}
                        </span>
                        <p>{draft.body}</p>
                        <p>人工依据：{draft.evidence}</p>
                        <div className="mr-actions">
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={freshness?.fresh !== true}
                            onClick={() => {
                              setEditingDraftId(draft.id);
                              setDraftPath(draft.path);
                              setDraftSide(draft.side);
                              setDraftLine(String(draft.line));
                              setDraftBody(draft.body);
                              setDraftEvidence(draft.evidence);
                            }}
                          >
                            编辑
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={freshness?.fresh !== true}
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
                <div className="review-grid">
                  <nav className="review-navigation">
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
                    <div className={`nav-content${navigation === 'files' && fileView === 'tree' ? ' tree-mode' : ''}`}>
                      {navigation === 'files' ? (
                        fileView === 'list' ? (
                          snapshot.files.map((item) => (
                            <FileNavItem
                              key={item.id}
                              item={item}
                              selected={selectedFile === item.id}
                              onSelect={chooseFile}
                            />
                          ))
                        ) : (
                          <FileTree
                            key={snapshot.id}
                            files={snapshot.files}
                            selectedFile={selectedFile}
                            onSelect={chooseFile}
                          />
                        )
                      ) : review.guide ? (
                        <>
                          <p className="nav-caption">按业务顺序阅读</p>
                          {review.guide.groups.map((item, index) => (
                            <button
                              key={index}
                              className={`group-item ${selectedGroup === index ? 'active' : ''}`}
                              onClick={() => chooseGroup(index)}
                            >
                              <span>{String(index + 1).padStart(2, '0')}</span>
                              <div>
                                <strong>{item.title}</strong>
                                <small>
                                  {item.changeIds.length} 处变更 · {groupStatusLabel(index)}
                                </small>
                              </div>
                            </button>
                          ))}
                          {review.guide.unreviewed.length > 0 && (
                            <div className="unreviewed">
                              <strong>未分析 · {review.guide.unreviewed.length}</strong>
                              {review.guide.unreviewed.map((item) => (
                                <p key={item.changeId}>
                                  {
                                    snapshot.files.find((file) =>
                                      file.changes.some((change) => change.id === item.changeId),
                                    )?.path
                                  }
                                  ：{item.reason}
                                </p>
                              ))}
                            </div>
                          )}
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
                      {changes.length} 处变更 · {snapshot.refs.length} 个源码片段
                    </div>
                  </nav>
                  <section className="code-section">
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
                          <button type="button" title="折叠全部文件" aria-label="折叠全部文件" onClick={() => setCollapsedFiles(new Set(snapshot.files.map((item) => item.id)))}>折叠</button>
                        </div>
                      )}
                      <details className="diff-options">
                        <summary aria-label="差异显示设置" title="差异显示设置">显示设置 ▾</summary>
                        <div className="diff-options-menu">
                          <strong>比较变更</strong>
                          <button
                            type="button"
                            aria-pressed={diffLayout === 'side-by-side'}
                            onClick={() => setDiffLayout('side-by-side')}
                          >
                            {diffLayout === 'side-by-side' ? '✓' : ''} 并排
                          </button>
                          <button
                            type="button"
                            aria-pressed={diffLayout === 'inline'}
                            onClick={() => setDiffLayout('inline')}
                          >
                            {diffLayout === 'inline' ? '✓' : ''} 内联
                          </button>
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
                    {!showOneFile && file ? (
                      <div className="all-files-scroll" ref={allFilesScroll}>
                        {snapshot.files.map((item) => (
                          <FileDiffCard
                            key={item.id}
                            file={item}
                            base={snapshot.base}
                            target={snapshot.target}
                            activeRef={selectedFile === item.id ? activeRef : null}
                            diffLayout={diffLayout}
                            showWhitespaceChanges={showWhitespaceChanges}
                            expanded={!collapsedFiles.has(item.id)}
                            scrollRoot={allFilesScroll}
                            onToggle={() => setCollapsedFiles((current) => {
                              const next = new Set(current);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })}
                            onLine={(side, line) => chooseLine(side, line, item)}
                          />
                        ))}
                      </div>
                    ) : file && !file.issue && !showWhitespaceChanges ? (
                      <StaticDiffPanel file={file} activeRef={activeRef} onLine={chooseLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} />
                    ) : (
                      <CodePanel file={file} activeRef={activeRef} onLine={chooseLine} diffLayout={diffLayout} showWhitespaceChanges={showWhitespaceChanges} />
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
                  <aside className="guide-panel">
                    <div className="panel-heading">
                      <span>
                        <Icon name="spark" size={17} />
                        AI 导读
                      </span>
                      <span className="provider-label">CODEX</span>
                    </div>
                    <div className="guide-scroll">
                      <div className="generate-block">
                        <button
                          className="generate-button"
                          disabled={busy || !status?.subscription}
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
                          <button
                            className="secondary-button report-button"
                            onClick={() => void exportReport()}
                          >
                            导出审查报告（Markdown）
                          </button>
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
                      {review.guide ? (
                        <>
                          <p className="guide-overview">{review.guide.overview}</p>
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
                              <section className="detail-section review-state-section">
                                <h3>人工审查状态</h3>
                                <label>
                                  当前判断
                                  <select
                                    aria-label="人工审查状态"
                                    value={reviewStatus}
                                    onChange={(event) =>
                                      setReviewStatus(event.target.value as typeof reviewStatus)
                                    }
                                  >
                                    <option value="unread">未阅读</option>
                                    <option value="understood">已理解</option>
                                    <option value="question">有疑问</option>
                                    <option value="verified">已核实</option>
                                  </select>
                                </label>
                                <label>
                                  人工依据或疑问
                                  <textarea
                                    aria-label="人工依据或疑问"
                                    value={reviewEvidence}
                                    onChange={(event) => setReviewEvidence(event.target.value)}
                                    rows={3}
                                    maxLength={5000}
                                    placeholder="例如：手动复现、测试结果或尚待确认的契约"
                                  />
                                </label>
                                <button
                                  className="secondary-button"
                                  disabled={
                                    savingReviewState ||
                                    !selectedHash ||
                                    (reviewStatus === 'verified' &&
                                      (!reviewEvidence.trim() || freshness?.fresh !== true)) ||
                                    (reviewStatus === (savedState?.status ?? 'unread') &&
                                      reviewEvidence === (savedState?.evidence ?? ''))
                                  }
                                  onClick={() => void saveReviewState()}
                                >
                                  {savingReviewState ? '保存中…' : '保存人工状态'}
                                </button>
                                {freshness?.fresh === false && (
                                  <p className="muted small">
                                    源码已变化，请创建当前快照后重新核实。
                                  </p>
                                )}
                              </section>
                              <form className="question-form" onSubmit={ask}>
                                <label htmlFor="question">围绕这个分组继续追问</label>
                                <textarea
                                  id="question"
                                  value={question}
                                  onChange={(event) => setQuestion(event.target.value)}
                                  placeholder="例如：请求失败后，状态如何恢复？"
                                  rows={3}
                                  maxLength={4000}
                                />
                                <button
                                  type="submit"
                                  className="secondary-button"
                                  disabled={!question || busy || !status?.subscription}
                                >
                                  发送问题
                                  <Icon name="arrow" size={14} />
                                </button>
                              </form>
                            </div>
                          )}
                          <p className="evidence-disclaimer">
                            引用和变更覆盖已校验；逐条判断以人工记录为准。脚本运行结果不自动证明业务判断。
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
                      {review.answers.length > 0 && (
                        <section className="detail-section">
                          <h3>追问记录</h3>
                          {review.answers.map((item, index) => (
                            <details
                              className="answer-item"
                              key={index}
                              open={index === review.answers.length - 1}
                            >
                              <summary>{item.question}</summary>
                              <p className="muted small">{item.groupTitle}</p>
                              <AnswerView
                                answer={item.answer}
                                refs={snapshot.refs}
                                onRef={showRef}
                              />
                            </details>
                          ))}
                        </section>
                      )}
                      {review.guide && (
                        <section className="detail-section verification-section">
                          <h3>可复现验证</h3>
                          <p className="muted small">
                            仅使用目标 commit 根目录的检查脚本；请人工指定触发条件和预期结果。
                          </p>
                          {verificationOptionError ? (
                            <p className="muted small">{verificationOptionError}</p>
                          ) : !verificationOptions ? (
                            <p className="muted small">正在检查隔离环境…</p>
                          ) : snapshot.mode && snapshot.mode !== 'commits' ? (
                            <p className="muted small">{verificationOptions.reason}</p>
                          ) : (
                            <>
                              {!verificationOptions.available && (
                                <p className="muted small">{verificationOptions.reason}</p>
                              )}
                              {verificationOptions.scripts.length === 0 && (
                                <p className="muted small">目标 commit 中没有可选的检查脚本。</p>
                              )}
                              <label>
                                待核对判断
                                <select
                                  aria-label="待核对判断"
                                  value={verificationCaseId}
                                  onChange={(event) => setVerificationCaseId(event.target.value)}
                                >
                                  <option value="">请选择</option>
                                  {[...verificationOptions.cases]
                                    .sort(
                                      (a, b) =>
                                        Number(isCaseUnresolved(b)) - Number(isCaseUnresolved(a)),
                                    )
                                    .map((item) => (
                                      <option key={item.id} value={item.id}>
                                        {isCaseUnresolved(item) ? '待核对 · ' : ''}
                                        {item.title}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              {verificationCaseId && (
                                <p className="muted small">
                                  {
                                    verificationOptions.cases.find(
                                      (item) => item.id === verificationCaseId,
                                    )?.focus
                                  }
                                </p>
                              )}
                              <label>
                                执行脚本
                                <select
                                  aria-label="执行脚本"
                                  value={verificationScript}
                                  onChange={(event) => setVerificationScript(event.target.value)}
                                >
                                  <option value="">请选择</option>
                                  {verificationOptions.scripts.map((item) => (
                                    <option key={item.name} value={item.name}>
                                      {item.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {verificationScript && (
                                <p className="muted small verification-command">
                                  npm run {verificationScript} →{' '}
                                  {
                                    verificationOptions.scripts.find(
                                      (item) => item.name === verificationScript,
                                    )?.body
                                  }
                                </p>
                              )}
                              <label>
                                触发条件
                                <textarea
                                  aria-label="验证触发条件"
                                  value={verificationTrigger}
                                  onChange={(event) => setVerificationTrigger(event.target.value)}
                                  rows={2}
                                  maxLength={2000}
                                />
                              </label>
                              <label>
                                预期可观察结果
                                <textarea
                                  aria-label="预期可观察结果"
                                  value={verificationExpected}
                                  onChange={(event) => setVerificationExpected(event.target.value)}
                                  rows={2}
                                  maxLength={2000}
                                />
                              </label>
                              <button
                                className="secondary-button"
                                disabled={
                                  !verificationOptions.available ||
                                  !verificationCaseId ||
                                  !verificationScript ||
                                  !verificationTrigger.trim() ||
                                  !verificationExpected.trim() ||
                                  verificationTask?.state === 'running'
                                }
                                onClick={() => void startVerification()}
                              >
                                {verificationTask?.state === 'running'
                                  ? '隔离验证中…'
                                  : '运行选定检查'}
                              </button>
                            </>
                          )}
                          {(review.verificationRecords ?? [])
                            .slice()
                            .reverse()
                            .map((record) => (
                              <details key={record.id} className="verification-record">
                                <summary>
                                  {record.caseTitle} ·{' '}
                                  {record.timedOut ? '超时' : `退出码 ${record.exitCode ?? '未知'}`}
                                </summary>
                                <p className="muted small">
                                  {record.scriptName} · {record.startedAt} · {short(record.target)}
                                </p>
                                <p className="muted small">
                                  {record.guideFingerprint === review.guideFingerprint
                                    ? '对应当前导读'
                                    : '导读已变化，关联待重核'}
                                </p>
                                <p>触发：{record.trigger}</p>
                                <p>预期：{record.expected}</p>
                                <pre>
                                  输出：{record.stdout || '无'}
                                  {'\n'}错误：{record.stderr || '无'}
                                  {record.outputTruncated ? '\n（输出已截断）' : ''}
                                </pre>
                              </details>
                            ))}
                        </section>
                      )}
                      <section className="detail-section notes-section">
                        <div className="notes-heading">
                          <h3>我的理解与笔记</h3>
                          <span>{file ? '当前文件' : '快照'}</span>
                        </div>
                        <textarea
                          aria-label="我的理解与笔记"
                          value={note}
                          onChange={(event) => {
                            setDrafts((current) => ({
                              ...current,
                              [draftKey]: event.target.value,
                            }));
                            setNoteFeedback('');
                          }}
                          placeholder="记录你的理解、疑问或核实结果…"
                          rows={4}
                          maxLength={20000}
                        />
                        <div className="note-actions">
                          <span>{noteChanged ? '尚未保存' : noteFeedback}</span>
                          <button
                            className="secondary-button"
                            disabled={savingNote || !noteChanged}
                            onClick={() => void saveNote()}
                          >
                            {savingNote ? '保存中…' : '保存笔记'}
                          </button>
                        </div>
                      </section>
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
                        <p>运行记录仅代表所选脚本的结果，不自动证明具体业务判断。</p>
                      </details>
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
