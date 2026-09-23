import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { structuredPatch } from 'diff';
import { parse } from '@babel/parser';
import {
  traverseFast,
  isFunctionDeclaration,
  isVariableDeclarator,
  isArrowFunctionExpression,
  isFunctionExpression,
  isImportDeclaration,
  isImportSpecifier,
  isCallExpression,
  isClassMethod,
  isIdentifier,
} from '@babel/types';
import type {
  Side,
  Snapshot,
  SourceRef,
  ReviewFile,
  Requirement,
  RepositoryVersionOption,
  SnapshotMode,
} from '../shared/types.js';
import { AppError } from './errors.js';
import { findStaticReferences, type ChangedSymbol } from './symbols.js';

const exec = promisify(execFile);
const FILE_LIMIT = 256 * 1024;
const SNAPSHOT_LIMIT = 8 * 1024 * 1024;
const codePattern = /\.[cm]?[jt]sx?$/;

// Git 只读取对象，清除宿主 Git 重定向变量，避免误读另一个仓库。
export async function git(
  repo: string,
  args: string[],
  maxBuffer = 12 * 1024 * 1024,
): Promise<Buffer> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const result = await exec(
    'git',
    ['--no-pager', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    {
      encoding: 'buffer',
      maxBuffer,
      timeout: 30_000,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    },
  );
  return result.stdout;
}

interface RawChange {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: string;
  oldPath: string;
  path: string;
}

interface ReadResult {
  text: string | null;
  issue: string | null;
  oid: string;
}

// NUL 分隔保留空格、冒号和换行文件名；重命名有两个路径，不能按行拆分。
export function parseRawDiff(raw: string): RawChange[] {
  const tokens = raw.split('\0');
  const result: RawChange[] = [];
  for (let i = 0; i < tokens.length && tokens[i]; ) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z]\d*)$/.exec(tokens[i++]);
    if (!match || !tokens[i]) throw new AppError(422, '无法解析 Git 变更列表。');
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    const oldPath = tokens[i++];
    const filePath = /^[RC]/.test(status) ? tokens[i++] : oldPath;
    if (!filePath) throw new AppError(422, 'Git 重命名缺少目标路径。');
    result.push({ oldMode, newMode, oldOid, newOid, status, oldPath, path: filePath });
  }
  return result;
}

async function readBlob(
  repo: string,
  oid: string,
  mode: string,
): Promise<{ text: string | null; issue: string | null }> {
  if (/^0+$/.test(oid)) return { text: '', issue: null };
  if (mode === '160000')
    return { text: null, issue: '子模块变更：首版仅记录 commit，不展开内容。' };
  if (mode === '120000') return { text: null, issue: '符号链接变更：不跟随链接读取目标。' };
  const size = Number((await git(repo, ['cat-file', '-s', oid])).toString().trim());
  if (size > FILE_LIMIT)
    return { text: null, issue: `文件超过 ${FILE_LIMIT / 1024} KB，未读取内容。` };
  const bytes = await git(repo, ['cat-file', 'blob', oid], FILE_LIMIT + 1024);
  const { text, issue } = textResult(bytes, oid);
  return { text, issue };
}

function textResult(bytes: Buffer, oid: string): ReadResult {
  if (bytes.includes(0))
    return { text: null, issue: '二进制文件：保留变更记录，不生成文本导读。', oid };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), issue: null, oid };
  } catch {
    return { text: null, issue: '非 UTF-8 文件：首版不转换编码。', oid };
  }
}

// 未提交文件只读且不跟随符号链接，内容指纹用于冻结快照和后续过期检查。
async function readWorkFile(repo: string, filePath: string): Promise<ReadResult> {
  const full = path.resolve(repo, filePath);
  const relative = path.relative(repo, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new AppError(400, '文件路径超出仓库。');
  const before = await lstat(full);
  if (before.isSymbolicLink()) {
    const target = await readlink(full);
    return {
      text: null,
      issue: '符号链接变更：不跟随链接读取目标。',
      oid: `worktree:${createHash('sha256').update(`link:${target}`).digest('hex')}`,
    };
  }
  if (!before.isFile())
    return {
      text: null,
      issue: '非普通文件或子模块：首版不展开内容。',
      oid: `worktree:${createHash('sha256').update(`mode:${before.mode}`).digest('hex')}`,
    };
  if (before.size > FILE_LIMIT)
    return {
      text: null,
      issue: `文件超过 ${FILE_LIMIT / 1024} KB，未读取内容。`,
      oid: `worktree:${createHash('sha256')
        .update(`${before.size}:${before.mtimeMs}:${before.ctimeMs}`)
        .digest('hex')}`,
    };
  // lstat 与读取之间若被替换为链接，O_NOFOLLOW 会拒绝目标读取。
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || !opened.isFile())
      throw new AppError(409, '文件在创建快照时发生变化，请重试。');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length > FILE_LIMIT) throw new AppError(409, '文件在读取期间超过大小限制，请重试。');
  const after = await lstat(full);
  if (
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.size !== after.size
  )
    throw new AppError(409, '文件在创建快照时发生变化，请重试。');
  return textResult(bytes, `worktree:${createHash('sha256').update(bytes).digest('hex')}`);
}

async function readStageFile(repo: string, filePath: string): Promise<ReadResult | null> {
  const entry = (
    await git(repo, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', filePath])
  ).toString();
  const rows = entry.split('\0').filter(Boolean);
  if (rows.some((row) => /^\d{6} [a-f0-9]+ [123]\t/.test(row)))
    throw new AppError(409, `暂存区存在冲突：${filePath}`);
  const row = rows.find((value) => value.endsWith(`\t${filePath}`));
  const match = row && /^(\d{6}) ([a-f0-9]+) 0\t/.exec(row);
  if (!match) return null;
  const value = await readBlob(repo, match[2], match[1]);
  return { ...value, oid: match[2] };
}

export async function listUntracked(repoInput: string): Promise<string[]> {
  const repo = await realpath(
    (await git(repoInput, ['rev-parse', '--show-toplevel'])).toString().trim(),
  );
  const paths = (
    await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], 2 * 1024 * 1024)
  )
    .toString()
    .split('\0')
    .filter(Boolean);
  if (paths.length > 2000) throw new AppError(422, '未跟踪文件超过 2000 个，请缩小仓库范围。');
  return paths;
}

// 只列出本地已有且指向提交的引用；不执行 fetch，也不把远端 HEAD 别名当作独立版本。
export async function listRepositoryVersions(repoInput: string): Promise<RepositoryVersionOption[]> {
  let repo: string;
  try {
    repo = await realpath(
      (await git(repoInput, ['rev-parse', '--show-toplevel'])).toString().trim(),
    );
  } catch {
    throw new AppError(400, '所填路径不是可读取的 Git 仓库。');
  }
  const rows = (
    await git(repo, [
      'for-each-ref',
      '--format=%(refname)%09%(objecttype)%09%(*objecttype)%09%(symref)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ])
  )
    .toString()
    .split('\n')
    .filter(Boolean);
  if (rows.length > 2000) throw new AppError(422, '仓库版本超过 2000 个，请手动填写引用或 commit。');
  const options: RepositoryVersionOption[] = [];
  // 空仓库或未检出提交时 HEAD 不可作为比较端点，其他已存在的引用仍可选择。
  try {
    await git(repo, ['rev-parse', '--verify', '-q', '--end-of-options', 'HEAD^{commit}']);
    options.push({ value: 'HEAD', label: '当前 HEAD', kind: 'head' });
  } catch (error) {
    // -q 对缺失 HEAD 返回 1；其余 Git 故障继续报错，避免伪装成空仓库。
    if ((error as { code?: number }).code !== 1) throw error;
  }
  for (const row of rows) {
    const [value, objectType, peeledType, symref] = row.split('\t');
    if (symref || (objectType !== 'commit' && peeledType !== 'commit')) continue;
    if (value.startsWith('refs/heads/')) {
      options.push({ value, label: `本地分支 · ${value.slice(11)}`, kind: 'local' });
    } else if (value.startsWith('refs/remotes/')) {
      options.push({ value, label: `远端分支 · ${value.slice(13)}`, kind: 'remote' });
    } else if (value.startsWith('refs/tags/')) {
      options.push({ value, label: `标签 · ${value.slice(10)}`, kind: 'tag' });
    }
  }
  return options;
}

interface SymbolInfo {
  name: string;
  start: number;
  end: number;
}
interface Structure {
  symbols: SymbolInfo[];
  imports: string[];
  importBindings: { source: string; imported: string; local: string; line: number }[];
  calls: { name: string; line: number }[];
  issue: string | null;
}

function structure(code: string, filePath: string): Structure {
  if (!codePattern.test(filePath) || !code)
    return { symbols: [], imports: [], importBindings: [], calls: [], issue: null };
  try {
    const ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: [
        ...(/\.[cm]?tsx?$/.test(filePath) ? ['typescript' as const] : []),
        'jsx',
        'decorators-legacy',
      ],
    });
    const symbols: SymbolInfo[] = [];
    const imports: string[] = [];
    const importBindings: Structure['importBindings'] = [];
    const calls: Structure['calls'] = [];
    traverseFast(ast, (node) => {
      let name: string | undefined;
      if (isFunctionDeclaration(node)) name = node.id?.name;
      if (
        isVariableDeclarator(node) &&
        isIdentifier(node.id) &&
        (isArrowFunctionExpression(node.init) || isFunctionExpression(node.init))
      )
        name = node.id.name;
      if (isClassMethod(node) && isIdentifier(node.key)) name = node.key.name;
      if (name && node.loc)
        symbols.push({ name, start: node.loc.start.line, end: node.loc.end.line });
      if (isImportDeclaration(node)) {
        imports.push(node.source.value);
        for (const specifier of node.specifiers)
          if (isImportSpecifier(specifier))
            importBindings.push({
              source: node.source.value,
              imported: isIdentifier(specifier.imported)
                ? specifier.imported.name
                : specifier.imported.value,
              local: specifier.local.name,
              line: node.loc?.start.line ?? 1,
            });
      }
      if (isCallExpression(node) && isIdentifier(node.callee) && node.loc)
        calls.push({ name: node.callee.name, line: node.loc.start.line });
    });
    return { symbols, imports, importBindings, calls, issue: null };
  } catch (error) {
    return {
      symbols: [],
      imports: [],
      importBindings: [],
      calls: [],
      issue: `语法解析失败，仍可查看原始 diff：${
        error instanceof Error ? error.message.split('\n')[0] : '未知语法'
      }`,
    };
  }
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

function addRef(
  snapshot: Snapshot,
  side: Side,
  filePath: string,
  blobOid: string,
  text: string,
  start: number,
  end: number,
  role: SourceRef['role'],
  label: string,
): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  const first = Math.max(1, Math.min(start, lines.length));
  const last = Math.max(first, Math.min(end, lines.length));
  const existing = snapshot.refs.find(
    (ref) =>
      ref.side === side &&
      ref.path === filePath &&
      ref.startLine === first &&
      ref.endLine === last &&
      (role === 'reference'
        ? ref.role === 'reference' && ref.label === label
        : ref.role !== 'reference'),
  );
  if (existing) return existing.id;
  // 新增的静态引用使用独立 ID；否则旧快照中后续 ref-N 会因插入顺序被重新编号。
  const id =
    role === 'reference'
      ? `ref-static-${createHash('sha256')
          .update(JSON.stringify([side, filePath, first, last, label]))
          .digest('hex')
          .slice(0, 16)}`
      : `ref-${snapshot.refs.filter((ref) => ref.role !== 'reference').length + 1}`;
  snapshot.refs.push({
    id,
    side,
    path: filePath,
    blobOid,
    startLine: first,
    endLine: last,
    code: lines.slice(first - 1, last).join('\n'),
    role,
    label,
  });
  return id;
}

async function resolveFile(
  repo: string,
  commit: string,
  filePath: string,
): Promise<{ oid: string; text: string } | null> {
  const entry = (
    await git(repo, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', filePath])
  ).toString();
  const match = /^(100\d{3}) blob ([a-f0-9]+)\t/.exec(entry);
  if (!match) return null;
  const value = await readBlob(repo, match[2], match[1]);
  return value.text === null ? null : { oid: match[2], text: value.text };
}

async function resolveSnapshotFile(
  snapshot: Snapshot,
  side: Side,
  filePath: string,
): Promise<{ oid: string; text: string } | null> {
  if (side === 'before' || !snapshot.mode || snapshot.mode === 'commits')
    return resolveFile(
      snapshot.repo,
      side === 'before' ? snapshot.base : snapshot.target,
      filePath,
    );
  const value =
    snapshot.mode === 'staged'
      ? await readStageFile(snapshot.repo, filePath)
      : await readWorkFile(snapshot.repo, filePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
  return value?.text === null || !value ? null : { oid: value.oid, text: value.text };
}

// 上下文是有限的静态线索；导入与调用匹配仍标为候选，不声称已经证明运行时可达。
async function collectRelated(
  snapshot: Snapshot,
  structures: Map<string, Structure>,
): Promise<void> {
  for (const side of ['before', 'after'] as const) {
    const commit = side === 'before' ? snapshot.base : snapshot.target;
    const seen = new Set(
      snapshot.files.map((file) => (side === 'before' ? file.oldPath : file.path)),
    );
    let remaining = 10;
    const changedNames = new Set<string>();
    const sources = new Map<string, string>();
    const sourceOids = new Map<string, string>();
    const declarations: ChangedSymbol[] = [];
    for (const file of snapshot.files) {
      const filePath = side === 'before' ? file.oldPath : file.path;
      const fileText = side === 'before' ? file.before : file.after;
      if (fileText !== null && codePattern.test(filePath)) {
        sources.set(filePath, fileText);
        sourceOids.set(filePath, side === 'before' ? file.oldOid : file.newOid);
      }
      const info = structures.get(`${side}:${file.id}`);
      if (!info) continue;
      for (const symbol of info.symbols) {
        const related = file.changes.filter((change) => {
          const start = side === 'before' ? change.oldStart : change.newStart;
          const count = side === 'before' ? change.oldLines : change.newLines;
          return count > 0 && symbol.start <= start + count - 1 && symbol.end >= start;
        });
        if (related.length) {
          changedNames.add(symbol.name);
          declarations.push({
            path: filePath,
            name: symbol.name,
            startLine: symbol.start,
            endLine: symbol.end,
            changeIds: related.map((change) => change.id),
          });
        }
      }
      for (const imported of info.imports.filter((value) => value.startsWith('.'))) {
        if (remaining === 0) break;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), imported));
        if (base.startsWith('../') || path.posix.isAbsolute(base)) continue;
        for (const candidate of [
          base,
          ...[
            '.ts',
            '.tsx',
            '.js',
            '.jsx',
            '/index.ts',
            '/index.tsx',
            '/index.js',
            '/index.jsx',
          ].map((ext) => base + ext),
        ]) {
          if (seen.has(candidate)) break;
          const resolved = await resolveSnapshotFile(snapshot, side, candidate);
          if (!resolved) continue;
          seen.add(candidate);
          remaining--;
          if (codePattern.test(candidate)) {
            sources.set(candidate, resolved.text);
            sourceOids.set(candidate, resolved.oid);
          }
          addRef(
            snapshot,
            side,
            candidate,
            resolved.oid,
            resolved.text,
            1,
            120,
            'dependency',
            `${filePath} 的相对导入（前 120 行）`,
          );
          break;
        }
      }
    }
    const names = [...changedNames].filter((name) => name.length >= 3).slice(0, 6);
    if (names.length && remaining > 0) {
      let matches: string;
      const source =
        side === 'after' && snapshot.mode && snapshot.mode !== 'commits'
          ? snapshot.mode === 'staged'
            ? ['--cached']
            : []
          : [commit];
      try {
        matches = (
          await git(
            snapshot.repo,
            [
              'grep',
              ...source.filter((value) => value === '--cached'),
              '-l',
              '-z',
              '-I',
              '-F',
              ...names.flatMap((name) => ['-e', name]),
              ...source.filter((value) => value !== '--cached'),
              '--',
              '*.js',
              '*.jsx',
              '*.ts',
              '*.tsx',
            ],
            2 * 1024 * 1024,
          )
        ).toString();
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) matches = '';
        else throw error;
      }
      for (const match of matches.split('\0').filter(Boolean)) {
        const filePath = source.includes(commit) ? match.slice(commit.length + 1) : match;
        if (seen.has(filePath) || remaining === 0) continue;
        const resolved = await resolveSnapshotFile(snapshot, side, filePath);
        if (!resolved) continue;
        sources.set(filePath, resolved.text);
        sourceOids.set(filePath, resolved.oid);
        const lines = resolved.text.split('\n');
        const index = lines.findIndex((line) => names.some((name) => line.includes(name)));
        if (index < 0) continue;
        const caller = structure(resolved.text, filePath);
        const changedFiles = new Set(
          snapshot.files.map((file) =>
            (side === 'before' ? file.oldPath : file.path).replace(/\.[cm]?[jt]sx?$/, ''),
          ),
        );
        const direct = caller.importBindings.find((binding) => {
          if (!binding.source.startsWith('.') || !names.includes(binding.imported)) return false;
          const importPath = path.posix
            .normalize(path.posix.join(path.posix.dirname(filePath), binding.source))
            .replace(/\.[cm]?[jt]sx?$/, '');
          return (
            changedFiles.has(importPath) && caller.calls.some((call) => call.name === binding.local)
          );
        });
        const callLine = direct
          ? caller.calls.find((call) => call.name === direct.local)?.line
          : undefined;
        seen.add(filePath);
        remaining--;
        const isTest = /(?:test|spec)[./]|__tests__/.test(filePath);
        // 显式导入加同名调用只证明静态线索；局部遮蔽和运行时路径仍需人工确认。
        if (direct && callLine && Math.abs(callLine - direct.line) > 15)
          addRef(
            snapshot,
            side,
            filePath,
            resolved.oid,
            resolved.text,
            direct.line - 3,
            direct.line + 6,
            'candidate',
            `显式导入 ${direct.imported}（静态候选）`,
          );
        addRef(
          snapshot,
          side,
          filePath,
          resolved.oid,
          resolved.text,
          (callLine ?? index + 1) - 15,
          (callLine ?? index + 1) + 45,
          isTest ? 'test' : 'candidate',
          isTest
            ? '相关测试源码（未执行）'
            : direct
            ? `显式导入并调用 ${direct.imported}（静态候选，运行时待核对）`
            : '符号文本匹配（未证明调用关系）',
        );
      }
    }
    if (
      declarations.length &&
      sources.size <= 60 &&
      [...sources.values()].join('').length <= 1_500_000
    ) {
      try {
        for (const reference of findStaticReferences(sources, declarations.slice(0, 6))) {
          const text = sources.get(reference.path);
          const oid = sourceOids.get(reference.path);
          if (!text || !oid) continue;
          const refId = addRef(
            snapshot,
            side,
            reference.path,
            oid,
            text,
            reference.line,
            reference.line,
            'reference',
            `TypeScript 静态引用 ${reference.symbol}（运行时待核对）`,
          );
          const ref = snapshot.refs.find((item) => item.id === refId);
          if (ref)
            ref.relatedChangeIds = [
              ...new Set([...(ref.relatedChangeIds ?? []), ...reference.changeIds]),
            ];
        }
      } catch (error) {
        snapshot.gaps.push(
          `${side === 'before' ? '修改前' : '修改后'}静态符号定位失败，仍保留原有候选：${
            error instanceof Error ? error.message : '未知错误'
          }`,
        );
      }
    } else if (declarations.length) {
      snapshot.gaps.push(
        `${
          side === 'before' ? '修改前' : '修改后'
        }静态符号定位超出 60 文件或 150 万字符范围，仍保留原有候选。`,
      );
    }
  }
  snapshot.gaps.push(
    '上下文仅补充每侧最多 10 个相关文件；TypeScript 静态符号引用仅覆盖载入的 JS/TS 文本。显式导入和同名文本仍为候选；别名路径、动态调用及运行时可达性需要人工核对。',
  );
}

async function populateSnapshot(
  snapshot: Snapshot,
  changes: RawChange[],
  readAfter: (item: RawChange) => Promise<ReadResult>,
): Promise<void> {
  const repo = snapshot.repo;
  if (changes.length > 300)
    throw new AppError(422, '本次超过 300 个变更文件，请选择更小的版本范围。');
  let bytes = 0;
  const structures = new Map<string, Structure>();
  for (const [index, item] of changes.entries()) {
    const [before, after] = await Promise.all([
      readBlob(repo, item.oldOid, item.oldMode),
      readAfter(item),
    ]);
    bytes += Buffer.byteLength(before.text ?? '') + Buffer.byteLength(after.text ?? '');
    if (bytes > SNAPSHOT_LIMIT) throw new AppError(422, '文本快照超过 8 MB，请缩小版本范围。');
    const file: ReviewFile = {
      ...item,
      newOid: after.oid,
      id: `file-${index + 1}`,
      before: before.text,
      after: after.text,
      additions: 0,
      deletions: 0,
      issue: before.issue ?? after.issue,
      changes: [],
    };
    for (const side of ['before', 'after'] as const) {
      const info = structure(
        (side === 'before' ? file.before : file.after) ?? '',
        side === 'before' ? file.oldPath : file.path,
      );
      structures.set(`${side}:${file.id}`, info);
      if (info.issue)
        snapshot.gaps.push(
          `${side === 'before' ? '修改前' : '修改后'} ${file.path}：${info.issue}`,
        );
    }
    const hunks =
      file.before !== null && file.after !== null
        ? structuredPatch(file.oldPath, file.path, file.before, file.after, '', '', { context: 3 })
            .hunks
        : [];
    if (hunks.length === 0) {
      file.changes.push({
        id: `${file.id}:metadata`,
        fileId: file.id,
        label: file.issue ?? '路径或文件模式变化',
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 0,
        refIds: [],
      });
    }
    for (const [hunkIndex, hunk] of hunks.entries()) {
      file.additions += hunk.lines.filter((line) => line.startsWith('+')).length;
      file.deletions += hunk.lines.filter((line) => line.startsWith('-')).length;
      file.changes.push({
        id: `${file.id}:hunk-${hunkIndex + 1}`,
        fileId: file.id,
        label: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        refIds: [],
      });
    }
    for (const change of file.changes) {
      for (const side of ['before', 'after'] as const) {
        const text = side === 'before' ? file.before : file.after;
        if (!text) continue;
        const start = side === 'before' ? change.oldStart : change.newStart;
        const count = side === 'before' ? change.oldLines : change.newLines;
        const info = structures.get(`${side}:${file.id}`)!;
        const enclosing = info.symbols
          .filter((symbol) => symbol.start <= start && symbol.end >= start + count - 1)
          .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        const wholeSymbol = enclosing && enclosing.end - enclosing.start < 160;
        const first = wholeSymbol ? enclosing.start : Math.max(1, start - 12);
        const last = wholeSymbol
          ? enclosing.end
          : Math.min(lineCount(text), start + Math.max(count, 1) + 12);
        const refId = addRef(
          snapshot,
          side,
          side === 'before' ? file.oldPath : file.path,
          side === 'before' ? file.oldOid : file.newOid,
          text,
          first,
          last,
          'change',
          wholeSymbol ? enclosing.name : '变更上下文',
        );
        if (refId) change.refIds.push(refId);
      }
    }
    snapshot.files.push(file);
  }
  if (snapshot.files.length) await collectRelated(snapshot, structures);
}

function requirementsId(requirements: Requirement[]): string {
  return createHash('sha256').update(JSON.stringify(requirements)).digest('hex').slice(0, 32);
}

export async function createSnapshot(
  repoInput: string,
  baseInput: string,
  targetInput: string,
  requirements: Requirement[] = [],
): Promise<Snapshot> {
  const repo = await realpath(
    (await git(repoInput, ['rev-parse', '--show-toplevel'])).toString().trim(),
  );
  const resolveCommit = async (ref: string) =>
    (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]))
      .toString()
      .trim();
  const [base, target] = await Promise.all([resolveCommit(baseInput), resolveCommit(targetInput)]);
  const v1Id = createHash('sha256')
    .update(JSON.stringify(['v1', repo, base, target]))
    .digest('hex')
    .slice(0, 32);
  const id = requirements.length
    ? createHash('sha256')
        .update(JSON.stringify(['v2', v1Id, requirementsId(requirements)]))
        .digest('hex')
        .slice(0, 32)
    : v1Id;
  const snapshot: Snapshot = {
    id,
    repo,
    base,
    target,
    mode: 'commits',
    requirements,
    baseLabel: baseInput,
    targetLabel: targetInput,
    createdAt: new Date().toISOString(),
    files: [],
    refs: [],
    gaps: [],
  };
  const raw = await git(repo, [
    'diff',
    '--raw',
    '--no-abbrev',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    base,
    target,
    '--',
  ]);
  await populateSnapshot(snapshot, parseRawDiff(raw.toString()), async (item) => ({
    ...(await readBlob(repo, item.newOid, item.newMode)),
    oid: item.newOid,
  }));
  return snapshot;
}

export async function createLiveSnapshot(
  repoInput: string,
  mode: Exclude<SnapshotMode, 'commits'>,
  untracked: string[] = [],
  requirements: Requirement[] = [],
): Promise<Snapshot> {
  const repo = await realpath(
    (await git(repoInput, ['rev-parse', '--show-toplevel'])).toString().trim(),
  );
  let base: string;
  try {
    base = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim();
  } catch {
    throw new AppError(400, '提交前审查需要仓库已有一个 HEAD 提交。');
  }
  if (mode === 'staged' && untracked.length)
    throw new AppError(400, '暂存区模式不接受未跟踪文件。');
  const selected = [...new Set(untracked)].sort();
  if (selected.length) {
    const available = new Set(await listUntracked(repo));
    if (selected.some((filePath) => !available.has(filePath)))
      throw new AppError(409, '所选未跟踪文件已经变化，请刷新列表。');
  }
  const conflict = await git(repo, ['ls-files', '--unmerged', '-z']);
  if (conflict.length) throw new AppError(409, '仓库存在未解决的暂存区冲突，请先处理。');
  const diffArgs = [
    'diff',
    ...(mode === 'staged' ? ['--cached'] : []),
    '--raw',
    '--no-abbrev',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    base,
    '--',
  ];
  const initialRaw = await git(repo, diffArgs);
  const changes = parseRawDiff(initialRaw.toString());
  const zero = '0'.repeat(base.length);
  for (const filePath of selected) {
    const stats = await lstat(path.join(repo, filePath));
    changes.push({
      oldMode: '000000',
      newMode: stats.isSymbolicLink() ? '120000' : stats.mode & 0o111 ? '100755' : '100644',
      oldOid: zero,
      newOid: zero,
      status: 'A',
      oldPath: filePath,
      path: filePath,
    });
  }
  const snapshot: Snapshot = {
    id: zero.slice(0, 32),
    repo,
    base,
    target: mode === 'staged' ? 'STAGED' : 'WORKTREE',
    mode,
    untracked: selected,
    requirements,
    baseLabel: 'HEAD',
    targetLabel: mode === 'staged' ? '暂存区' : '工作区',
    createdAt: new Date().toISOString(),
    files: [],
    refs: [],
    gaps: [],
  };
  await populateSnapshot(snapshot, changes, async (item) => {
    if (item.newMode === '000000') return { text: '', issue: null, oid: item.newOid };
    if (mode === 'working') return readWorkFile(repo, item.path);
    const value = await readStageFile(repo, item.path);
    if (!value || value.oid !== item.newOid)
      throw new AppError(409, '暂存区在创建快照时发生变化，请重试。');
    return value;
  });
  if (!(await git(repo, diffArgs)).equals(initialRaw))
    throw new AppError(409, '仓库在创建快照时发生变化，请重试。');
  if (mode === 'working') {
    // Git raw diff 对工作区文件使用零 OID；逐个复核内容指纹才可认为快照固定。
    const afterFiles = new Map(
      snapshot.files
        .filter((file) => file.newMode !== '000000')
        .map((file) => [file.path, file.newOid]),
    );
    for (const ref of snapshot.refs.filter(
      (item) => item.side === 'after' && item.blobOid.startsWith('worktree:'),
    ))
      afterFiles.set(ref.path, ref.blobOid);
    for (const [filePath, oid] of afterFiles) {
      if ((await readWorkFile(repo, filePath)).oid !== oid)
        throw new AppError(409, '文件在创建快照时发生变化，请重试。');
    }
  }
  snapshot.id = createHash('sha256')
    .update(
      JSON.stringify([
        'v2-live',
        repo,
        base,
        mode,
        selected,
        requirements,
        snapshot.files.map((file) => [
          file.status,
          file.oldPath,
          file.path,
          file.oldMode,
          file.newMode,
          file.oldOid,
          file.newOid,
        ]),
        snapshot.refs
          .filter((ref) => ref.role !== 'reference')
          .map((ref) => [ref.side, ref.path, ref.blobOid]),
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return snapshot;
}
