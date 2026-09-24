import { useState } from 'react';
import type { SavedReview, SymbolImpact, SymbolLocation, SymbolRelation } from '../shared/types.js';
import { currentFileStatus } from './file-review.js';

const kindLabel: Record<SymbolRelation['kind'], string> = {
  definition: '定义', incoming_call: '入站调用', outgoing_call: '出站调用', read: '读取', write: '写入',
  argument: '参数传递', return: '返回值', reference: '引用', test: '测试引用',
};
const changeLabel = { added: '新增', removed: '删除', unchanged: '两侧均有' };
const confidenceLabel = { exact: '精确符号引用', static_candidate: '静态候选', text_candidate: '文本候选' };
const statusLabel = { unread: '未阅读', in_progress: '审查中', question: '有疑问', reviewed: '已审查' };
const groupFor = (kind: SymbolRelation['kind']) => kind === 'incoming_call' ? '入站调用和引用文件' :
  kind === 'outgoing_call' ? '出站调用和依赖文件' : kind === 'test' ? '相关测试文件' :
    kind === 'definition' ? '当前定义文件' : '数据来源、转换和状态写入文件';
const groupOrder = ['当前定义文件', '入站调用和引用文件', '出站调用和依赖文件',
  '数据来源、转换和状态写入文件', '相关测试文件', '静态或文本候选文件'];
const relationGroups = [
  { key: 'definition', title: '当前定义' },
  { key: 'incoming', title: '谁调用或引用它' },
  { key: 'outgoing', title: '它调用或读取什么' },
  { key: 'test', title: '测试引用' },
  { key: 'candidate', title: '静态或文本候选' },
  { key: 'other', title: '更多关系' },
] as const;
type RelationGroup = (typeof relationGroups)[number]['key'];

// 以当前符号为中心呈现方向；展开一层带来的非当前符号关系单列，避免误称为直接影响。
function relationGroup(relation: SymbolRelation, selectedIds: Set<string>): RelationGroup {
  const fromSelected = selectedIds.has(relation.from);
  const toSelected = selectedIds.has(relation.to);
  if (!fromSelected && !toSelected) return 'other';
  if (relation.kind === 'definition') return 'definition';
  if (relation.confidence !== 'exact') return 'candidate';
  if (relation.kind === 'test') return 'test';
  if (toSelected && !fromSelected) return 'incoming';
  if (fromSelected && !toSelected) return 'outgoing';
  return 'other';
}

export function SymbolImpactPanel({ impact, review, open, loading, onClose, onNavigate, onExpand }: {
  impact: SymbolImpact; review: SavedReview; open: boolean; loading: boolean;
  onClose: () => void;
  onNavigate: (location: SymbolLocation, fileOnly?: boolean) => void;
  onExpand: (location: SymbolLocation) => void;
}) {
  const [kind, setKind] = useState<'all' | 'call' | 'data' | 'test'>('all');
  const [change, setChange] = useState<'all' | SymbolRelation['change']>('all');
  const [reviewStatus, setReviewStatus] = useState('all');
  const statusFor = (path: string) => {
    const file = review.snapshot.files.find((item) => item.path === path || item.oldPath === path);
    return file ? currentFileStatus(review, file, true) : 'outside';
  };
  const matchesKind = (relation: SymbolRelation) => kind === 'all' ||
    kind === 'call' && ['incoming_call', 'outgoing_call'].includes(relation.kind) ||
    kind === 'data' && ['read', 'write', 'argument', 'return', 'reference'].includes(relation.kind) ||
    kind === 'test' && relation.kind === 'test';
  const filtered = impact.relations.filter((relation) => matchesKind(relation) &&
    (change === 'all' || relation.change === change) &&
    (reviewStatus === 'all' || [
      ...relation.locations,
      ...(impact.nodes.find((node) => node.id === relation.from)?.locations ?? []),
      ...(impact.nodes.find((node) => node.id === relation.to)?.locations ?? []),
    ].some((loc) => statusFor(loc.path) === reviewStatus)));
  const activeRelations = filtered;
  const isPrimaryLocation = (loc: SymbolLocation) => impact.selected.locations.some((point) =>
    point.path === loc.path && point.blobOid === loc.blobOid && point.line === loc.line && point.column === loc.column);
  const selectedIds = new Set(impact.nodes.filter((node) => node.locations.some(isPrimaryLocation)).map((node) => node.id));
  const nodes = new Map(impact.nodes.map((node) => [node.id, node]));
  const groupedRelations = relationGroups.map((group) => ({ ...group,
    relations: activeRelations.filter((relation) => relationGroup(relation, selectedIds) === group.key),
  })).filter((group) => group.relations.length);
  const expandableLocation = (nodeId: string) => {
    const node = nodes.get(nodeId);
    if (!node || selectedIds.has(node.id) || node.id.startsWith('candidate:') ||
        !/^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u.test(node.name)) return null;
    const loc = node.locations.find((item) => item.side === 'after') ?? node.locations[0];
    return loc && loc.endColumn - loc.column === node.name.length ? loc : null;
  };
  const byFile = new Map<string, { locations: SymbolLocation[]; labels: Set<string>; changes: Set<string>; groups: Set<string> }>();
  const addFileLocation = (loc: SymbolLocation, label: string, changed: string, group: string) => {
    const current = byFile.get(loc.path) ?? { locations: [], labels: new Set<string>(), changes: new Set<string>(), groups: new Set<string>() };
    if (!current.locations.some((item) => item.side === loc.side && item.blobOid === loc.blobOid &&
        item.line === loc.line && item.column === loc.column)) current.locations.push(loc);
    current.labels.add(label);
    current.changes.add(changed);
    current.groups.add(group);
    byFile.set(loc.path, current);
  };
  for (const relation of activeRelations) {
    for (const loc of relation.locations) addFileLocation(loc,
      `${kindLabel[relation.kind]}${relation.confidence === 'exact' ? '' : ` · ${confidenceLabel[relation.confidence]}`}`,
      changeLabel[relation.change], relation.confidence !== 'exact' ? '静态或文本候选文件' :
        relation.kind === 'definition' && !isPrimaryLocation(loc) ? '数据来源、转换和状态写入文件' : groupFor(relation.kind));
    for (const nodeId of [relation.from, relation.to]) {
      const node = impact.nodes.find((item) => item.id === nodeId);
      if (!node) continue;
      const selected = node.locations.some(isPrimaryLocation);
      const nodeChange = node.locations.some((loc) => loc.side === 'before') && node.locations.some((loc) => loc.side === 'after')
        ? '两侧均有' : node.locations[0]?.side === 'after' ? '新增' : '删除';
      for (const loc of node.locations) addFileLocation(loc, selected ? '当前定义' : `${node.name} 定义`,
        nodeChange, selected ? '当前定义文件' : relation.kind === 'definition' ? '数据来源、转换和状态写入文件' : groupFor(relation.kind));
    }
  }
  const paths = [...byFile];
  const primaryGroup = (groups: Set<string>) => groupOrder.find((group) => groups.has(group)) ?? '静态或文本候选文件';
  return <div className={`symbol-impact-shell${open ? ' open' : ''}`} aria-hidden={!open}>
    <div className="symbol-impact-header">
      <div><strong>符号影响链 · {impact.selected.name}</strong><small>{impact.selected.kind} · {impact.selected.type}</small></div>
      <button type="button" onClick={onClose} aria-label="关闭影响链">关闭</button>
    </div>
    <div className="symbol-impact-scroll">
      <p className="muted small">从当前符号出发查看关系；点击一条关系可查看固定源码位置。已索引 {impact.indexedFiles} 个源码文件 · 快照 {impact.snapshotId.slice(0, 8)}。候选需人工核对，静态关系不证明运行时调用。</p>
      <div className="symbol-impact-filters">
        <label>关系 <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="all">全部</option><option value="call">调用</option><option value="data">数据流</option><option value="test">测试</option>
        </select></label>
        <label>前后 <select value={change} onChange={(event) => setChange(event.target.value as typeof change)}>
          <option value="all">全部</option><option value="added">新增</option><option value="removed">删除</option><option value="unchanged">两侧均有</option>
        </select></label>
        <label>人工状态 <select value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value)}>
          <option value="all">全部</option><option value="unread">未阅读</option><option value="in_progress">审查中</option><option value="question">有疑问</option><option value="reviewed">已审查</option><option value="outside">不在变更清单</option>
        </select></label>
      </div>
      <section className="symbol-impact-relations"><h3>关系 <small>{activeRelations.length} 条</small></h3>
        {groupedRelations.map((group) => <div className="symbol-relation-group" key={group.key}>
          <h4>{group.title} <small>{group.relations.length}</small></h4>
          <div className="symbol-relation-list">{group.relations.map((relation) => {
            const from = nodes.get(relation.from);
            const to = nodes.get(relation.to);
            const first = relation.locations[0];
            const expandTargets = [...new Set([relation.from, relation.to])].flatMap((id) => {
              const loc = expandableLocation(id);
              return loc ? [{ id, loc }] : [];
            });
            return <details className="symbol-relation" key={relation.id}>
              <summary>
                <span className="symbol-relation-meta">{kindLabel[relation.kind]} · {changeLabel[relation.change]} · {confidenceLabel[relation.confidence]}</span>
                <strong>{relation.kind === 'definition' ? `${from?.name ?? relation.from} 的定义` :
                  <>{from?.name ?? relation.from} <span aria-hidden="true">→</span> {to?.name ?? relation.to}</>}</strong>
                {first && <small>{first.path}:L{first.line}{relation.locations.length > 1 ? ` 等 ${relation.locations.length} 处` : ''}</small>}
              </summary>
              <div className="symbol-relation-detail">
                <span>固定源码位置</span>
                <div>{relation.locations.map((loc, index) => <button type="button" key={`${loc.side}:${loc.path}:${loc.line}:${loc.column}:${index}`}
                  onClick={() => onNavigate(loc)}>{loc.side === 'before' ? '前' : '后'} · {loc.path}:L{loc.line}:{loc.column}</button>)}</div>
                {expandTargets.map(({ id, loc }) => <button type="button" className="symbol-relation-expand"
                  key={id} onClick={() => onExpand(loc)}>展开 {nodes.get(id)?.name} 一层</button>)}
              </div>
            </details>;
          })}</div>
        </div>)}
        {!activeRelations.length && <p className="muted small">当前筛选条件下没有关系。</p>}
      </section>
      <details className="symbol-related-files"><summary>相关文件 <small>{paths.length} 个</small></summary>
        {[...new Set(paths.map(([, value]) => primaryGroup(value.groups)))].map((group) => <div key={group}>
          <h4>{group}</h4>
          {paths.filter(([, value]) => primaryGroup(value.groups) === group).map(([path, value]) => {
            const changed = review.snapshot.files.find((item) => item.path === path || item.oldPath === path);
            const first = value.locations[0];
            return <div className="symbol-related-file" key={`${group}:${path}`}>
              <button type="button" className="symbol-file-path" onClick={() => onNavigate(first, true)}>{path}</button>
              <small>{[...value.labels].join('、')} · {[...value.changes].join('、')} · {changed ? `+${changed.additions}/-${changed.deletions} · ${statusLabel[statusFor(path) as keyof typeof statusLabel]}` : '不在变更清单'}</small>
              <details className="symbol-file-locations"><summary>固定源码位置 · {value.locations.length} 处</summary>
                <div>{value.locations.map((loc, index) => <button type="button" key={`${loc.side}:${loc.line}:${loc.column}:${index}`}
                  onClick={() => onNavigate(loc)}>{loc.side === 'before' ? '前' : '后'} L{loc.line}:{loc.column} · {loc.blobOid.slice(0, 8)}</button>)}</div>
              </details>
            </div>;
          })}
        </div>)}
      </details>
      <section className="symbol-impact-limitations"><h3>覆盖边界</h3>{impact.limitations.map((item, index) => <p key={index}>{item}</p>)}</section>
    </div>
    {loading && <div className="symbol-impact-loading">正在读取固定版本中的下一层关系…</div>}
  </div>;
}
