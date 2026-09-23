import type { Guide, Statement } from './types.js';

export interface ReviewClaim {
  key: string;
  label: string;
  statement: Statement;
  changeIds: string[];
}

// 审查对象来自现有导读中的具体判断；键只标识位置，内容变化由整份导读指纹使旧结论失效。
export function listClaims(guide: Guide): ReviewClaim[] {
  const claims: ReviewClaim[] = [];
  for (const [index, group] of guide.groups.entries()) {
    const prefix = `group:${index}`;
    claims.push({
      key: `${prefix}:before`,
      label: `${group.title} · 修改前`,
      statement: group.before,
      changeIds: group.changeIds,
    });
    claims.push({
      key: `${prefix}:after`,
      label: `${group.title} · 修改后`,
      statement: group.after,
      changeIds: group.changeIds,
    });
    group.notes.forEach((statement, noteIndex) =>
      claims.push({
        key: `${prefix}:note:${noteIndex}`,
        label: `${group.title} · 关键规则 ${noteIndex + 1}`,
        statement,
        changeIds: group.changeIds,
      }),
    );
  }
  for (const link of guide.requirementLinks ?? [])
    claims.push({
      key: `requirement:${link.requirementId}`,
      label: `需求 ${link.requirementId}`,
      statement: link.statement,
      changeIds: link.changeIds,
    });
  for (const [index, step] of (guide.flowSteps ?? []).entries())
    claims.push({
      key: `flow:${index}`,
      label: `${guide.groups[step.groupIndex]?.title ?? '未知分组'} · ${step.stage}`,
      statement: step.statement,
      changeIds: guide.groups[step.groupIndex]?.changeIds ?? [],
    });
  return claims;
}
