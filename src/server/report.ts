import { listClaims } from '../shared/claims.js';
import type { SavedReview, SourceRef } from '../shared/types.js';

const escapeText = (value: string) =>
  value.replace(/\r?\n/g, ' ').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');

const decisionLabel = {
  confirmed: '人工已确认',
  question: '人工有疑问',
  rejected: '人工认为不成立',
} as const;

function sourceLocation(ref: SourceRef): string {
  return `${ref.side === 'before' ? '修改前' : '修改后'} ${escapeText(ref.path)}:${ref.startLine}-${
    ref.endLine
  }`;
}

function commentDraftLines(review: SavedReview, fresh: boolean): string[] {
  const binding = review.gitlab;
  if (!binding) return [];
  const lines = [
    `- MR：${escapeText(binding.url)}`,
    `- 标题：${escapeText(binding.title)}`,
    `- GitLab diff 版本：${binding.versionId}`,
    `- 本地快照：${review.snapshot.id}`,
    `- 当前状态：${fresh ? '与导入版本一致' : 'MR 已变化，所有草稿待重新定位'}`,
    '- 发布状态：仅本地草稿，未向 GitLab 提交',
    '',
  ];
  if (!review.commentDrafts?.length) lines.push('尚无评论草稿。', '');
  for (const draft of review.commentDrafts ?? []) {
    const location = draft.scope === 'file' ? '文件级' :
      `${draft.line}${draft.scope === 'range' && draft.endLine ? `-${draft.endLine}` : ''}（${draft.side === 'after' ? '新增行' : '删除行'}）`;
    lines.push(
      `### ${escapeText(draft.path)}:${location}`,
      '',
      `- 位置：${escapeText(draft.oldPath)} → ${escapeText(draft.path)}`,
      `- 关联 diff 版本：${draft.versionId}${
        fresh && draft.versionId === binding.versionId && draft.anchorStatus !== 'pending' ? '' : '（待重核）'
      }`,
      `- 类型：${({ problem: '问题', blocking: '阻断', suggestion: '建议', detail: '细节' } as const)[draft.category ?? 'problem']}`,
      `- 本地状态：${draft.resolved ? '已解决' : '未解决'}${draft.anchorStatus === 'pending' ? '；位置待重新定位' : ''}`,
      `- 问题：${escapeText(draft.body)}`,
      `- 人工依据：${escapeText(draft.evidence)}`,
      '',
    );
    if (draft.suggestion) {
      const fence = '`'.repeat(Math.max(3, ...[...draft.suggestion.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      lines.push(`${fence}suggestion`, draft.suggestion, fence, '');
    }
  }
  return lines;
}

// 导出内容只供人工核对和手动复制，不能作为平台评论已发布的证明。
export function formatCommentDrafts(review: SavedReview, fresh: boolean): string {
  if (!review.gitlab) throw new Error('此快照没有关联 GitLab MR。');
  return ['# GitLab MR 评论草稿', '', ...commentDraftLines(review, fresh)].join('\n');
}

// 报告只陈列固定快照、模型判断与人工记录；过期或导读变化的旧状态不能充当当前结论。
export function formatReviewReport(review: SavedReview, fresh: boolean): string {
  const { snapshot, guide } = review;
  if (!guide) throw new Error('请先生成导读再导出审查报告。');
  const refs = new Map(snapshot.refs.map((ref) => [ref.id, ref]));
  const changes = new Map(
    snapshot.files.flatMap((file) => file.changes.map((change) => [change.id, file.path] as const)),
  );
  const lines = [
    '# 源码审查记录',
    '',
    `- 仓库：${escapeText(snapshot.repo)}`,
    `- 快照：${snapshot.id}`,
    `- 范围：${escapeText(snapshot.baseLabel)} → ${escapeText(snapshot.targetLabel)}`,
    `- 导出时源码状态：${fresh ? '与固定快照一致' : '已变化，旧人工结论待重核'}`,
    '- 报告性质：导读、人工记录与所选脚本运行证据，不代表自动审查通过或项目整体测试通过',
    '',
    '## 需求与变更',
    '',
  ];
  if (!snapshot.requirements?.length) lines.push('未输入需求或不得改变项。', '');
  for (const requirement of snapshot.requirements ?? []) {
    const link = guide.requirementLinks?.find((item) => item.requirementId === requirement.id);
    lines.push(
      `### ${requirement.kind === 'preserve' ? '不得改变' : '本次需求'}：${escapeText(
        requirement.text,
      )}`,
      '',
      `- 导读判断：${link ? escapeText(link.statement.text) : '旧版导读缺少需求对照'}`,
      `- 对应变更：${
        link?.changeIds.length
          ? link.changeIds
              .map((id) => `${escapeText(changes.get(id) ?? '未知文件')} (${escapeText(id)})`)
              .join('、')
          : '无，待人工核对'
      }`,
      '',
    );
  }
  lines.push('## 逐条判断与人工依据', '');
  for (const claim of listClaims(guide)) {
    const state = review.claimStates?.[claim.key];
    const valid = fresh && state?.guideFingerprint === review.guideFingerprint;
    const decision = state
      ? valid
        ? decisionLabel[state.status]
        : `旧记录待重核（原${decisionLabel[state.status]}）`
      : '未审查';
    lines.push(
      `### ${escapeText(claim.label)}`,
      '',
      `- 导读判断：${escapeText(claim.statement.text)}`,
      `- 依据类型：${claim.statement.basis === 'source' ? '源码片段' : '推断，待核实'}`,
      `- 源码位置：${
        claim.statement.refIds.length
          ? claim.statement.refIds
              .map((id) => refs.get(id))
              .filter((ref): ref is SourceRef => Boolean(ref))
              .map(sourceLocation)
              .join('；') || '引用已失效'
          : '无'
      }`,
      `- 人工状态：${decision}`,
    );
    if (state) lines.push(`- 人工记录：${escapeText(state.evidence)}`);
    lines.push('');
  }
  lines.push('## 分组人工状态与笔记', '');
  for (const [index, group] of guide.groups.entries()) {
    const hash = review.groupHashes?.[index];
    const state = hash ? review.reviewStates?.[hash] : undefined;
    const label = state
      ? state.status === 'verified'
        ? '已核实'
        : state.status === 'understood'
        ? '已理解'
        : '有疑问'
      : '未阅读';
    lines.push(
      `- ${escapeText(group.title)}：${state && !fresh ? `旧记录待重核（原${label}）` : label}${
        state?.evidence ? `；${escapeText(state.evidence)}` : ''
      }`,
    );
  }
  for (const [key, note] of Object.entries(review.notes))
    if (note) {
      const file = key.startsWith('file:')
        ? snapshot.files.find((item) => item.id === key.slice(5))
        : undefined;
      lines.push(`- 笔记 ${escapeText(file?.path ?? key)}：${escapeText(note)}`);
    }
  lines.push('');
  const staticRefs = snapshot.refs.filter((ref) => ref.role === 'reference');
  if (staticRefs.length) {
    lines.push('## 跨文件静态引用', '');
    for (const ref of staticRefs) lines.push(`- ${sourceLocation(ref)}：${escapeText(ref.label)}`);
    lines.push('', '静态符号引用不证明运行时可达。', '');
  }
  lines.push('## 隔离执行记录', '');
  if (!review.verificationRecords?.length) lines.push('尚未执行验证脚本。', '');
  for (const record of review.verificationRecords ?? []) {
    const currentGuide = record.guideFingerprint === review.guideFingerprint;
    lines.push(
      `### ${escapeText(record.caseTitle)}`,
      '',
      `- 关联判断：${escapeText(record.caseId)}${currentGuide ? '' : '（导读已变化，关联待重核）'}`,
      `- 触发条件：${escapeText(record.trigger)}`,
      `- 预期可观察结果：${escapeText(record.expected)}`,
      `- 固定快照：${record.snapshotId}；目标 commit：${record.target}`,
      `- 命令：${escapeText(record.command.join(' '))}`,
      `- commit 中的脚本：${escapeText(record.scriptBody)}`,
      `- 本地镜像 ID：${escapeText(record.imageId)}`,
      `- 执行时间：${escapeText(record.startedAt)} 至 ${escapeText(record.finishedAt)}（${
        record.durationMs
      } ms）`,
      `- 退出状态：${
        record.timedOut ? '超时' : record.exitCode === null ? '未取得退出码' : record.exitCode
      }`,
      `- 输出截断：${record.outputTruncated ? '是' : '否'}`,
      `- 标准输出：${escapeText(record.stdout || '无')}`,
      `- 标准错误：${escapeText(record.stderr || '无')}`,
      '',
    );
  }
  lines.push('脚本退出码只表示该命令的运行结果，不证明它覆盖或证实关联判断。', '');
  if (review.gitlab) lines.push('## GitLab MR 评论草稿', '', ...commentDraftLines(review, fresh));
  lines.push('## 尚待处理', '');
  const mapped = new Set(guide.requirementLinks?.flatMap((link) => link.changeIds) ?? []);
  const unmapped = [...changes.keys()].filter((id) => !mapped.has(id));
  if (snapshot.requirements?.length && unmapped.length)
    lines.push(
      `- 未对应输入需求的变更：${unmapped
        .map((id) => `${escapeText(changes.get(id) ?? '未知文件')} (${escapeText(id)})`)
        .join('、')}`,
    );
  for (const item of guide.unreviewed)
    lines.push(`- 未分析变更 ${escapeText(item.changeId)}：${escapeText(item.reason)}`);
  for (const group of guide.groups)
    for (const question of group.questions)
      lines.push(`- ${escapeText(group.title)}：${escapeText(question)}`);
  for (const limitation of [...snapshot.gaps, ...guide.limitations])
    lines.push(`- 范围限制：${escapeText(limitation)}`);
  if (!fresh) lines.push('- 源码已变化，所有旧人工结论须在新快照中重新核对。');
  lines.push(
    '',
    review.verificationRecords?.length
      ? '以上仅记录用户选定脚本在隔离环境中的运行结果；业务判断仍需人工核对。'
      : '测试源码只用于阅读；本工具未执行被审查项目的测试。',
    '',
  );
  return lines.join('\n');
}
