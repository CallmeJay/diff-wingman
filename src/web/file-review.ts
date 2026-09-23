import type { ReviewFile, SavedReview } from '../shared/types.js';
import { fileFingerprint } from '../shared/review-core.js';

export type FileStatus = 'unread' | 'in_progress' | 'question' | 'reviewed';
export type FileCategory = 'source' | 'test' | 'config' | 'style' | 'docs' | 'lock' | 'other';
export interface FileFilters {
  query: string;
  change: 'all' | 'added' | 'modified' | 'deleted' | 'renamed';
  status: 'all' | 'unreviewed' | FileStatus;
  category: 'all' | Exclude<FileCategory, 'other'>;
  comments: boolean;
  pending: boolean;
  unavailable: boolean;
}

export const defaultFileFilters: FileFilters = {
  query: '', change: 'all', status: 'all', category: 'all',
  comments: false, pending: false, unavailable: false,
};

export function currentFileStatus(review: SavedReview, file: ReviewFile, fresh: boolean): FileStatus {
  const saved = review.fileStates?.[file.id];
  return fresh && saved?.fingerprint === fileFingerprint(file) ? saved.status : 'unread';
}

export function fileCategory(path: string): FileCategory {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  const lower = path.toLowerCase();
  if (/(?:^|\/)(?:[^/]+\.lockb?|[^/]+-lock\.(?:json|ya?ml)|go\.sum|npm-shrinkwrap\.json)$/.test(lower)) return 'lock';
  if (/(?:^|\/)(?:__tests__|tests?|specs?)\//.test(lower) || /(?:\.|_)(?:test|spec)\.[^/]+$/.test(name)) return 'test';
  if (/\.(?:css|scss|sass|less|styl)$/.test(name)) return 'style';
  if (/(?:^|\/)(?:docs?|documentation)\//.test(lower) || /\.(?:md|mdx|rst|adoc)$/.test(name)) return 'docs';
  if (/^(?:package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|webpack\.config\.[^/]+|\.eslintrc[^/]*|eslint\.config\.[^/]+|\.prettierrc[^/]*)$/.test(name) || /\.(?:json|ya?ml|toml|ini|env)$/.test(name)) return 'config';
  if (/\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sol|html)$/.test(name)) return 'source';
  return 'other';
}

function fuzzyMatch(query: string, path: string): boolean {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const target = path.toLocaleLowerCase();
  const name = target.split('/').at(-1) ?? target;
  return terms.every((term) => {
    if (name.includes(term) || target.includes(term)) return true;
    let offset = 0;
    for (const character of term) {
      const found = target.indexOf(character, offset);
      if (found < 0) return false;
      offset = found + 1;
    }
    return true;
  });
}

function changeKind(file: ReviewFile): FileFilters['change'] {
  if (file.status.startsWith('R')) return 'renamed';
  if (file.status.startsWith('A')) return 'added';
  if (file.status.startsWith('D')) return 'deleted';
  return 'modified';
}

export function filterFiles(review: SavedReview, filters: FileFilters, fresh: boolean): ReviewFile[] {
  const unreviewedChanges = new Set(review.guide?.unreviewed.map((item) => item.changeId) ?? []);
  return review.snapshot.files.filter((file) => {
    const status = currentFileStatus(review, file, fresh);
    if (!fuzzyMatch(filters.query, file.path) && !fuzzyMatch(filters.query, file.oldPath)) return false;
    if (filters.change !== 'all' && changeKind(file) !== filters.change) return false;
    if (filters.status === 'unreviewed' ? !['unread', 'in_progress'].includes(status) :
      filters.status !== 'all' && status !== filters.status) return false;
    if (filters.category !== 'all' && fileCategory(file.path) !== filters.category) return false;
    if (filters.comments && !(
      review.localComments?.some((item) => item.fileId === file.id && item.fingerprint === fileFingerprint(file)) ||
      review.commentDrafts?.some((item) => item.path === file.path)
    )) return false;
    // “待确认”同时覆盖人工有疑问和导读明确列出的未分析变更，不推测整体限制所属文件。
    if (filters.pending && status !== 'question' && !file.changes.some((item) => unreviewedChanges.has(item.id))) return false;
    if (filters.unavailable && !file.issue) return false;
    return true;
  });
}

export function fileStatusCounts(review: SavedReview, fresh: boolean) {
  const result = { reviewed: 0, question: 0, unreviewed: 0 };
  for (const file of review.snapshot.files) {
    const status = currentFileStatus(review, file, fresh);
    if (status === 'reviewed') result.reviewed++;
    else if (status === 'question') result.question++;
    else result.unreviewed++;
  }
  return result;
}
