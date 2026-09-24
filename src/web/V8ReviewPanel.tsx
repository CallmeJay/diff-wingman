import { useEffect, useRef, useState } from 'react';
import type { HunkEvidence, SavedReview, SourceRef } from '../shared/types.js';
import { hunkCoverage } from '../shared/coverage.js';

const basisLabel: Record<HunkEvidence['basis'], string> = {
  source: '源码直接证据', requirement: '需求', mr: 'MR 描述', inference: 'AI 推断', pending: '待确认',
};
const analysisLabel = { not_generated: '逐块未生成', explained: '已解释', pending: '证据待确认', unreviewed: '阅读路线未分析' };
const understandingLabel = { unread: '未阅读', understood: '已理解', question: '有疑问', verified: '已核实', stale: '待重核' };

function EvidenceRows({ review, title, items, onSource }: {
  review: SavedReview; title: string; items: HunkEvidence[];
  onSource: (ref: SourceRef) => void;
}) {
  if (!items.length) return null;
  return <div className="v8-evidence-section"><strong>{title}</strong>{items.map((item, index) =>
    <div className="v8-evidence" key={`${title}-${index}`}>
      <p>{item.text}</p><small>{basisLabel[item.basis]}</small>
      {item.requirementId && <small> · {review.snapshot.requirements?.find((row) => row.id === item.requirementId)?.text ?? item.requirementId}</small>}
      {item.mrExcerpt && <blockquote>{item.mrExcerpt}</blockquote>}
      {item.refIds.map((id) => {
        const ref = review.snapshot.refs.find((row) => row.id === id);
        return ref && <button type="button" className="v8-source-link" key={id}
          onClick={() => onSource(ref)}>
          {ref.side === 'before' ? '修改前' : '修改后'} · {ref.path}:L{ref.startLine} · {ref.blobOid.slice(0, 8)}
        </button>;
      })}
    </div>)}</div>;
}

export function V8ReviewPanel({ review, changeId, fresh, stale, busy, canGenerate, onGenerateHunk, onUnderstanding, onChange, onMatrixClose, onSource }: {
  review: SavedReview;
  changeId: string | undefined;
  fresh: boolean;
  stale: boolean;
  busy: boolean;
  canGenerate: boolean;
  onGenerateHunk?: (changeId: string) => void;
  onUnderstanding: (changeId: string, status: 'unread' | 'understood' | 'question' | 'verified', evidence: string) => Promise<void>;
  onChange: (changeId: string) => void;
  onMatrixClose: () => void;
  onSource: (ref: SourceRef) => void;
}) {
  const rows = hunkCoverage(review);
  const unanalysed = rows.filter((row) => row.analysis === 'unreviewed');
  const active = rows.find((row) => row.change.id === changeId) ?? rows[0];
  const card = active && review.hunkExplanations?.[active.change.id];
  const currentCard = card?.guideFingerprint === review.guideFingerprint ? card : undefined;
  const saved = active && review.hunkUnderstandingStates?.[active.change.id];
  const [status, setStatus] = useState<'unread' | 'understood' | 'question' | 'verified'>('unread');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const matrixDialog = useRef<HTMLDialogElement>(null);
  const matrixTrigger = useRef<HTMLButtonElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const pendingMatrixChange = useRef<string | null>(null);
  useEffect(() => {
    setStatus(active?.understandingStatus === 'stale' ? 'unread' : (saved?.status ?? 'unread'));
    setEvidence(saved?.evidence ?? '');
  }, [active?.change.id, active?.understandingStatus, currentCard?.fingerprint, saved?.updatedAt]);
  if (!review.guide) return null;
  const shownStatus = (status: keyof typeof understandingLabel) => stale && status !== 'unread'
    ? `待重核 · 原${understandingLabel[status]}` : understandingLabel[status];
  const locateActiveRow = () => activeRow.current?.scrollIntoView({ block: 'center' });
  const openMatrix = () => {
    // 矩阵只放大当前快照的既有覆盖信息；关闭时保留代码阅读位置和人工状态。
    matrixDialog.current?.showModal();
    requestAnimationFrame(locateActiveRow);
  };
  return <section className="v8-panel">
    <h3>变更覆盖矩阵 <small>{rows.filter((row) => row.analysis === 'explained').length}/{rows.length} 处已解释</small></h3>
    <p className="v8-progress-note">已解释仅计入当前逐块解释且证据无待确认项的变更；导读归类和人工核对分别记录。</p>
    <button type="button" className="v8-matrix-trigger" ref={matrixTrigger} onClick={openMatrix}>查看全部变更与未分析项</button>
    <dialog className="v8-matrix-dialog" ref={matrixDialog} aria-labelledby="v8-matrix-title"
      onClose={() => {
        const changeId = pendingMatrixChange.current;
        pendingMatrixChange.current = null;
        if (changeId) onChange(changeId);
        else if (window.matchMedia('(max-width: 1020px)').matches) onMatrixClose();
        else matrixTrigger.current?.focus();
      }}>
      <div className="v8-matrix-dialog-heading">
        <div><h3 id="v8-matrix-title">变更覆盖矩阵</h3><p>人工列记录逐块理解；文件审查、hunk 审查和逐条判断是独立记录。已核实需要人工依据。</p></div>
        <div className="v8-matrix-actions">
          <button type="button" onClick={locateActiveRow}>定位当前变更</button>
          <button type="button" onClick={() => matrixDialog.current?.close()}>关闭</button>
        </div>
      </div>
      <div className="v8-matrix-table" role="table" aria-label="变更覆盖矩阵">
        <div role="row" className="v8-matrix-heading"><span>变更</span><span>需求</span><span>AI</span><span>人工理解</span><span>评论</span></div>
        {rows.map((row) => <button type="button" role="row" className={row.change.id === active?.change.id ? 'selected' : ''}
          key={row.change.id} ref={row.change.id === active?.change.id ? activeRow : undefined}
          onClick={() => { pendingMatrixChange.current = row.change.id; matrixDialog.current?.close(); }}>
          <span data-label="变更" title={row.file.path}>{row.file.path} · {row.change.label}</span>
          <span data-label="需求">{row.requirementIds.length ? row.requirementIds.join(', ') : '未关联'}</span>
          <span data-label="AI">{analysisLabel[row.analysis]}</span><span data-label="人工理解">{shownStatus(row.understandingStatus)}</span>
          <span data-label="评论">{row.unresolvedComments}/{row.comments}{row.fileComments ? ` + 文件 ${row.fileComments}` : ''}</span>
        </button>)}
      </div>
      {rows.some((row) => row.analysis === 'unreviewed' || row.analysis === 'not_generated') &&
        <p className="muted small">未分析的变更仍保留在矩阵中，请逐项核对。</p>}
    </dialog>
    {unanalysed.length > 0 && <div className="v8-unanalysed">
      <strong>阅读路线未分析 · {unanalysed.length}</strong>
      {unanalysed.map((row) => <button type="button" key={row.change.id} onClick={() => onChange(row.change.id)}>
        {row.file.path} · {row.change.label} · {row.analysisReason}
      </button>)}
    </div>}
    {active && <div className="v8-card">
      <h3>当前变更解释 <small>{active.change.label}</small></h3>
      <p className="muted small">{active.file.path} · {analysisLabel[active.analysis]}{active.analysisReason ? ` · ${active.analysisReason}` : ''}</p>
      {stale && <p className="v8-stale">源码版本已变化，旧解释和人工理解需重新核对。</p>}
      {!currentCard ? <p className="muted small">{card ? '旧逐块解释已过期，需重新生成。' : '当前变更尚无逐块解释。'}</p> : <>
        <EvidenceRows review={review} title="改了什么" items={[currentCard.what]} onSource={onSource} />
        <EvidenceRows review={review} title="修改前" items={[currentCard.before]} onSource={onSource} />
        <EvidenceRows review={review} title="修改后" items={[currentCard.after]} onSource={onSource} />
        <EvidenceRows review={review} title="调用与状态影响" items={currentCard.impacts} onSource={onSource} />
        <EvidenceRows review={review} title="失败路径" items={currentCard.failures} onSource={onSource} />
        <EvidenceRows review={review} title="测试源码线索" items={currentCard.tests} onSource={onSource} />
        <EvidenceRows review={review} title="缺少的证据" items={currentCard.pending} onSource={onSource} />
      </>}
      {!currentCard && !active.file.issue && active.change.id.includes(':hunk-') && onGenerateHunk &&
        <button type="button" className="secondary-button" disabled={!fresh || busy || !canGenerate}
        onClick={() => onGenerateHunk(active.change.id)}>生成此块解释</button>}
      {currentCard && <div className="v8-understanding">
        <strong>独立理解状态</strong>
        {active.understandingStatus === 'stale' && <p>旧状态待重核，请重新检查当前解释。</p>}
        <select aria-label="当前变更理解状态" value={status} disabled={!fresh || saving}
          onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="unread">未阅读</option><option value="understood">已理解</option>
          <option value="question">有疑问</option><option value="verified">已核实</option>
        </select>
        <textarea aria-label="理解或核实依据" value={evidence} disabled={!fresh || saving}
          onChange={(event) => setEvidence(event.target.value)} placeholder="已核实状态需要填写人工依据" rows={2} />
        <button type="button" className="secondary-button" disabled={!fresh || saving || (status === 'verified' && !evidence.trim())}
          onClick={() => { setSaving(true); void onUnderstanding(active.change.id, status, evidence).finally(() => setSaving(false)); }}>
          {saving ? '保存中…' : '保存理解状态'}
        </button>
      </div>}
    </div>}
  </section>;
}
