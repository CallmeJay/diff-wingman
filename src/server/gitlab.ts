import { z } from 'zod';
import type { GitLabDiffFile, GitLabMergeRequest, Side, Snapshot } from '../shared/types.js';
import { AppError } from './errors.js';
import { git } from './git.js';

const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const versionSchema = z.object({
  id: z.number().int().positive(),
  base_commit_sha: sha,
  head_commit_sha: sha,
  start_commit_sha: sha,
});
const mrSchema = z.object({
  title: z.string(),
  diff_refs: z.object({ base_sha: sha, head_sha: sha, start_sha: sha }).nullable().optional(),
});
const diffSchema = z.object({
  old_path: z.string().min(1),
  new_path: z.string().min(1),
  diff: z.string(),
  collapsed: z.boolean().optional(),
  too_large: z.boolean().optional(),
});

export interface GitLabReader {
  load(repo: string, url: string): Promise<GitLabMergeRequest>;
  current(binding: GitLabMergeRequest): Promise<boolean>;
}

function parseMrUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(400, 'GitLab MR 链接无效。');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new AppError(400, '请输入不含凭证的 HTTPS GitLab MR 链接。');
  const match = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)(?:\/diffs)?\/?$/.exec(url.pathname);
  if (!match) throw new AppError(400, 'GitLab MR 链接必须指向具体合并请求。');
  let projectPath: string;
  try {
    projectPath = decodeURIComponent(match[1]);
  } catch {
    throw new AppError(400, 'GitLab 项目路径编码无效。');
  }
  if (projectPath.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new AppError(400, 'GitLab 项目路径无效。');
  return {
    url: `${url.origin}/${match[1]}/-/merge_requests/${match[2]}`,
    projectPath,
    iid: Number(match[2]),
    origin: url.origin,
  };
}

function remoteProject(input: string): { origin: string; path: string } | null {
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(input);
  if (scp && !input.includes('://'))
    return { origin: `https://${scp[1]}`, path: scp[2].replace(/\.git$/, '').replace(/^\//, '') };
  try {
    const url = new URL(input);
    if (!['https:', 'ssh:'].includes(url.protocol)) return null;
    return {
      origin: `https://${url.protocol === 'ssh:' ? url.hostname : url.host}`,
      path: decodeURIComponent(url.pathname)
        .replace(/^\//, '')
        .replace(/\.git$/, ''),
    };
  } catch {
    return null;
  }
}

// MR 链接只能指向所选本地仓库已有的 Git 远端，避免任意 URL 触发服务端请求。
async function assertMatchingRemote(
  repo: string,
  origin: string,
  projectPath: string,
): Promise<void> {
  const names = (await git(repo, ['remote'])).toString().split('\n').filter(Boolean);
  for (const name of names) {
    const value = (await git(repo, ['remote', 'get-url', name])).toString().trim();
    const parsed = remoteProject(value);
    if (parsed?.origin === origin && parsed.path === projectPath) return;
  }
  throw new AppError(400, 'MR 链接与所选仓库的 Git 远端不一致。');
}

// 只把 GitLab diff 中真正新增或删除的行作为草稿锚点，避免上下文行位置推算错误。
export function changedLines(patch: string): { addedLines: number[]; deletedLines: number[] } {
  const addedLines: number[] = [];
  const deletedLines: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const row of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
    } else if (inHunk && row.startsWith('+')) addedLines.push(newLine++);
    else if (inHunk && row.startsWith('-')) deletedLines.push(oldLine++);
    else if (inHunk && row.startsWith(' ')) {
      oldLine++;
      newLine++;
    } else if (inHunk && row.startsWith('\\')) {
      /* 无末尾换行标记不占行。 */
    } else if (inHunk && row !== '') throw new AppError(422, '无法解析 GitLab MR 的 diff 行位置。');
  }
  return { addedLines, deletedLines };
}

export function assertDiffMatchesSnapshot(files: GitLabDiffFile[], snapshot: Snapshot): void {
  const remote = files.map((file) => `${file.oldPath}\0${file.path}`).sort();
  const local = snapshot.files.map((file) => `${file.oldPath}\0${file.path}`).sort();
  if (remote.length !== local.length || remote.some((item, index) => item !== local[index]))
    throw new AppError(409, 'GitLab MR diff 与本地固定快照不一致，请核对远端版本和本地 Git 对象。');
}

export function assertCommentLine(
  binding: GitLabMergeRequest,
  path: string,
  side: Side,
  line: number,
): GitLabDiffFile {
  const file = binding.files.find((item) => item.path === path);
  if (!file || !(side === 'after' ? file.addedLines : file.deletedLines).includes(line))
    throw new AppError(400, '评论位置不是当前 MR diff 中的新增或删除行。');
  return file;
}

export function assertCommentAnchor(
  binding: GitLabMergeRequest,
  path: string,
  side: Side,
  line: number,
  scope: 'line' | 'range' | 'file' = 'line',
  endLine?: number,
): GitLabDiffFile {
  const file = binding.files.find((item) => item.path === path);
  if (!file) throw new AppError(400, '评论文件不属于当前 MR diff。');
  if (scope === 'file') {
    if (line !== 0 || endLine !== undefined)
      throw new AppError(400, '文件级评论不接受行号。');
    return file;
  }
  if (scope === 'line') {
    if (endLine !== undefined) throw new AppError(400, '单行评论不接受结束行号。');
    return assertCommentLine(binding, path, side, line);
  }
  if (!endLine || endLine <= line)
    throw new AppError(400, '多行评论需要大于起始行的结束行号。');
  const lines = side === 'after' ? file.addedLines : file.deletedLines;
  if (endLine - line + 1 > lines.length)
    throw new AppError(400, '多行评论必须位于同侧连续变更行。');
  const changed = new Set(lines);
  for (let current = line; current <= endLine; current++)
    if (!changed.has(current))
      throw new AppError(400, '多行评论必须位于同侧连续变更行。');
  return file;
}

export class GitLabClient implements GitLabReader {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async get<T>(origin: string, endpoint: string): Promise<{ data: T; next: string }> {
    const token = process.env.REVIEW_HELPER_GITLAB_TOKEN;
    if (token) {
      const host = process.env.REVIEW_HELPER_GITLAB_HOST;
      if (!host || `https://${host}` !== origin)
        throw new AppError(
          400,
          '配置 GitLab Token 时必须同时设置匹配 MR 域名的 REVIEW_HELPER_GITLAB_HOST。',
        );
    }
    const response = await this.request(`${origin}/api/v4${endpoint}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: token ? { 'PRIVATE-TOKEN': token } : {},
    }).catch(() => {
      throw new AppError(502, '无法连接 GitLab，请检查网络和 MR 链接。');
    });
    if (response.status === 401 || response.status === 403)
      throw new AppError(
        response.status,
        'GitLab 无权读取此 MR；私有仓库请配置 REVIEW_HELPER_GITLAB_TOKEN。',
      );
    if (!response.ok) throw new AppError(502, `GitLab 读取失败（HTTP ${response.status}）。`);
    const limit = 12 * 1024 * 1024;
    if (Number(response.headers.get('content-length') ?? 0) > limit)
      throw new AppError(422, 'GitLab 响应超过 12 MB，未导入。');
    const reader = response.body?.getReader();
    if (!reader) throw new AppError(502, 'GitLab 响应缺少内容。');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new AppError(422, 'GitLab 响应超过 12 MB，未导入。');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'GitLab 响应读取中断，请重试。');
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      return { data: JSON.parse(body) as T, next: response.headers.get('x-next-page') ?? '' };
    } catch {
      throw new AppError(502, 'GitLab 返回了无效 JSON。');
    }
  }

  private async latest(origin: string, projectPath: string, iid: number) {
    const project = encodeURIComponent(projectPath);
    const endpoint = `/projects/${project}/merge_requests/${iid}/versions?per_page=1`;
    const result = await this.get<unknown>(origin, endpoint);
    const versions = z.array(versionSchema).safeParse(result.data);
    if (!versions.success) throw new AppError(502, 'GitLab 返回的 MR 版本结构无效。');
    if (!versions.data.length) throw new AppError(409, 'MR 的 diff 版本尚未生成，请稍后重试。');
    return versions.data[0];
  }

  async load(repo: string, input: string): Promise<GitLabMergeRequest> {
    const link = parseMrUrl(input);
    await assertMatchingRemote(repo, link.origin, link.projectPath);
    const endpoint = `/projects/${encodeURIComponent(link.projectPath)}/merge_requests/${link.iid}`;
    const [rawMr, version] = await Promise.all([
      this.get<unknown>(link.origin, endpoint),
      this.latest(link.origin, link.projectPath, link.iid),
    ]);
    const parsedMr = mrSchema.safeParse(rawMr.data);
    if (!parsedMr.success) throw new AppError(502, 'GitLab 返回的 MR 信息结构无效。');
    const mr = parsedMr.data;
    if (
      !mr.diff_refs ||
      mr.diff_refs.base_sha !== version.base_commit_sha ||
      mr.diff_refs.head_sha !== version.head_commit_sha ||
      mr.diff_refs.start_sha !== version.start_commit_sha
    )
      throw new AppError(409, 'MR 版本仍在更新，请稍后重新导入。');
    const files: GitLabDiffFile[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await this.get<unknown>(
        link.origin,
        `${endpoint}/diffs?per_page=100&page=${page}`,
      );
      const parsedDiffs = z.array(diffSchema).safeParse(result.data);
      if (!parsedDiffs.success) throw new AppError(502, 'GitLab 返回的 MR diff 结构无效。');
      const rows = parsedDiffs.data;
      for (const item of rows) {
        if (item.collapsed || item.too_large)
          throw new AppError(422, 'GitLab MR 的 diff 存在折叠或超限文件，无法完整定位评论。');
        files.push({ oldPath: item.old_path, path: item.new_path, ...changedLines(item.diff) });
      }
      if (
        files.length > 300 ||
        files.reduce((sum, item) => sum + item.addedLines.length + item.deletedLines.length, 0) >
          20_000
      )
        throw new AppError(422, 'MR 超过 300 个文件或 20000 个变更行，未导入。');
      if (!result.next && rows.length < 100) break;
      if (page === 4 || (result.next && Number(result.next) !== page + 1))
        throw new AppError(422, 'GitLab MR diff 分页不完整，未导入。');
    }
    const current = await this.latest(link.origin, link.projectPath, link.iid);
    if (
      current.id !== version.id ||
      current.head_commit_sha !== version.head_commit_sha ||
      current.base_commit_sha !== version.base_commit_sha ||
      current.start_commit_sha !== version.start_commit_sha
    )
      throw new AppError(409, 'MR 在导入期间发生变化，请重新导入。');
    return {
      url: link.url,
      projectPath: link.projectPath,
      iid: link.iid,
      title: mr.title,
      versionId: version.id,
      baseSha: version.base_commit_sha,
      headSha: version.head_commit_sha,
      startSha: version.start_commit_sha,
      files,
    };
  }

  async current(binding: GitLabMergeRequest): Promise<boolean> {
    const origin = new URL(binding.url).origin;
    const version = await this.latest(origin, binding.projectPath, binding.iid);
    return (
      version.id === binding.versionId &&
      version.base_commit_sha === binding.baseSha &&
      version.head_commit_sha === binding.headSha &&
      version.start_commit_sha === binding.startSha
    );
  }
}
