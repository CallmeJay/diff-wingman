import ts from 'typescript';
import type { SavedReview, Side, SourceRef, SymbolImpact, SymbolLocation, SymbolNode, SymbolRelation } from '../shared/types.js';
import { AppError } from './errors.js';
import { git } from './git.js';
import { createSnapshotLanguageService, virtualPath, virtualRoot } from './symbols.js';

const codeFile = /\.[cm]?[jt]sx?$/;
const identifier = /^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u;
const maxFiles = 600;
const maxBytes = 12 * 1024 * 1024;
const maxFileBytes = 256 * 1024;

interface IndexedFile { oid: string; text: string }
type Index = Map<string, IndexedFile>;
interface Selection { path: string; side: Side; line: number; startColumn: number; endColumn: number; expand?: boolean }

// 关系索引只读取两棵固定 Git 树；达到资源上限直接拒绝，不能以部分索引冒充完整关系。
async function indexTree(repo: string, commit: string): Promise<{ files: Index; limitations: string[] }> {
  const raw = await git(repo, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit], 16 * 1024 * 1024);
  const entries = raw.toString('utf8').split('\0').filter(Boolean).flatMap((row) => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(row);
    if (!match) throw new AppError(422, '无法解析固定版本文件树。');
    return codeFile.test(match[5]) ? [{ mode: match[1], type: match[2], oid: match[3], size: Number(match[4]), path: match[5] }] : [];
  });
  if (entries.length > maxFiles) throw new AppError(422, `源码文件超过 ${maxFiles} 个，无法建立完整影响链索引。`);
  const eligible = entries.filter((item) => item.type === 'blob' && item.mode !== '120000' && item.size <= maxFileBytes);
  if (eligible.reduce((sum, item) => sum + item.size, 0) > maxBytes)
    throw new AppError(422, `源码总量超过 ${maxBytes / 1024 / 1024} MB，无法建立完整影响链索引。`);
  const limitations = entries.filter((item) => !eligible.includes(item)).map((item) => `${item.path}：非普通源码或超过 256 KB，未索引`);
  const files: Index = new Map();
  for (let offset = 0; offset < eligible.length; offset += 8) {
    await Promise.all(eligible.slice(offset, offset + 8).map(async (item) => {
      const bytes = await git(repo, ['cat-file', 'blob', item.oid], maxFileBytes + 1024);
      if (bytes.includes(0)) { limitations.push(`${item.path}：二进制内容，未索引`); return; }
      try { files.set(item.path, { oid: item.oid, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }); }
      catch { limitations.push(`${item.path}：非 UTF-8 内容，未索引`); }
    }));
  }
  return { files, limitations };
}

function at(source: ts.SourceFile, start: number, end: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node) => {
    if (node.getStart(source) > start || node.getEnd() < end) return;
    if (ts.isIdentifier(node) && node.getStart(source) === start && node.getEnd() === end) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function position(source: ts.SourceFile, line: number, column: number): number {
  if (line < 1 || line > source.getLineAndCharacterOfPosition(source.end).line + 1)
    throw new AppError(400, '选中的行不属于固定源码。');
  const start = source.getPositionOfLineAndCharacter(line - 1, 0);
  const end = line < source.getLineAndCharacterOfPosition(source.end).line + 1
    ? source.getPositionOfLineAndCharacter(line, 0) : source.end;
  if (column < 1 || start + column - 1 > end) throw new AppError(400, '选中的列不属于固定源码。');
  return start + column - 1;
}

function parentFunction(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent)
    if (ts.isFunctionLike(current)) return current;
  return undefined;
}

function functionName(node: ts.Node | undefined): string {
  if (!node) return '顶层代码';
  if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) return (node.name as ts.Identifier).text;
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return '匿名函数';
}

const declarationKeys = new WeakMap<ts.Declaration, string>();
function lexicalScope(node: ts.Node): string {
  const parts: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassDeclaration(current) || ts.isClassExpression(current) ||
        ts.isModuleDeclaration(current)) {
      const name = (current as ts.Node & { name?: ts.Node }).name;
      const variable = current.parent && ts.isVariableDeclaration(current.parent) ? current.parent.name : undefined;
      parts.push(`${ts.SyntaxKind[current.kind]}:${name && ts.isIdentifier(name) ? name.text :
        variable && ts.isIdentifier(variable) ? variable.text : 'anonymous'}`);
    }
  }
  return parts.reverse().join('/') || 'top';
}

function symbolKey(symbol: ts.Symbol): string | undefined {
  const declaration = symbol.declarations?.[0];
  if (!declaration || !declaration.getSourceFile().fileName.startsWith(`${virtualRoot}/`)) return undefined;
  const cached = declarationKeys.get(declaration);
  if (cached) return cached;
  const source = declaration.getSourceFile();
  const filePath = source.fileName.slice(virtualRoot.length + 1);
  const named = (node: ts.Node) => {
    const name = (node as ts.Node & { name?: ts.Node }).name;
    return name && ts.isIdentifier(name) ? name.text : undefined;
  };
  const name = named(declaration);
  const scope = lexicalScope(declaration);
  let ordinal = 0;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (node === declaration) { found = true; return; }
    if (node.kind === declaration.kind && named(node) === name && lexicalScope(node) === scope) ordinal++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) return undefined;
  // 同名局部声明按词法作用域和域内序号区分；行位移及函数重排不会互换身份。
  const key = `${filePath}::${scope}::${ts.SyntaxKind[declaration.kind]}:${symbol.getName()}#${ordinal}`;
  declarationKeys.set(declaration, key);
  return key;
}

function location(index: Index, side: Side, fileName: string, source: ts.SourceFile, start: number, length: number): SymbolLocation | undefined {
  const path = fileName.slice(virtualRoot.length + 1);
  const entry = index.get(path);
  if (!entry) return undefined;
  const point = source.getLineAndCharacterOfPosition(start);
  const nextLineStart = source.getLineStarts()[point.line + 1] ?? source.end;
  return { side, path, blobOid: entry.oid, line: point.line + 1, column: point.character + 1,
    endColumn: Math.min(point.character + Math.max(1, length) + 1, nextLineStart - source.getLineStarts()[point.line] + 1) };
}

function declarationSpan(node: ts.Node, source: ts.SourceFile): { start: number; length: number } {
  const named = node as ts.Node & { name?: ts.Node };
  const target = named.name && ts.isIdentifier(named.name) ? named.name :
    node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name : node;
  return { start: target.getStart(source), length: target.getWidth(source) };
}

function isImport(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent)
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
  return false;
}

function useKind(node: ts.Identifier): SymbolRelation['kind'] {
  // 写入对象成员会改变该对象的状态；沿成员链判断用途，但不能把对象本身误标为函数调用。
  let target: ts.Node = node;
  while (ts.isPropertyAccessExpression(target.parent) &&
      (target.parent.expression === target || target.parent.name === target) ||
      ts.isElementAccessExpression(target.parent) && target.parent.expression === target)
    target = target.parent;
  const parent = target.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(target as ts.Expression)) return 'argument';
  if (ts.isReturnStatement(parent)) return 'return';
  if (ts.isBinaryExpression(parent) && parent.left === target && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return 'write';
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) return 'write';
  if (ts.isCallExpression(parent) && parent.expression === target &&
      (target === node || ts.isPropertyAccessExpression(target) && target.name === node)) return 'incoming_call';
  return 'read';
}

function memberBaseWrite(node: ts.Identifier): boolean {
  return (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
    node.parent.expression === node && useKind(node) === 'write';
}

function collectSide(index: Index, side: Side, chosen: Selection, fallback?: { token: string; symbolName: string; symbolKey: string }) {
  const sources = new Map([...index].map(([name, value]) => [name, value.text]));
  const service = createSnapshotLanguageService(sources);
  try {
  const program = service.getProgram();
  if (!program) throw new AppError(422, 'TypeScript 无法建立源码索引。');
  const checker = program.getTypeChecker();
  const filename = virtualPath(chosen.path);
  const source = program.getSourceFile(filename);
  if (!source) return null;
  let selected: ts.Identifier | undefined;
  if (!fallback) {
    const start = position(source, chosen.line, chosen.startColumn);
    const end = position(source, chosen.line, chosen.endColumn);
    const text = source.text.slice(start, end);
    if (!identifier.test(text)) throw new AppError(400, '请选择一个完整的标识符。');
    selected = at(source, start, end);
  } else {
    const matches: ts.Identifier[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === fallback.token) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const symbols = new Map<string, ts.Identifier>();
    for (const match of matches) {
      let candidate = checker.getSymbolAtLocation(match);
      if (candidate && candidate.flags & ts.SymbolFlags.Alias) candidate = checker.getAliasedSymbol(candidate);
      const key = candidate && symbolKey(candidate);
      if (key === fallback.symbolKey && candidate?.getName() === fallback.symbolName) symbols.set(key, match);
    }
    if (symbols.size === 1) selected = [...symbols.values()][0];
  }
  if (!selected) return null;
  let symbol = checker.getSymbolAtLocation(selected);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol || !symbol.declarations?.length) return null;
  const selectedKey = symbolKey(symbol);
  if (!selectedKey) return null;
  const declaration = symbol.declarations[0];
  const declarationSource = declaration.getSourceFile();
  const declarationLocation = location(index, side, declarationSource.fileName, declarationSource,
    declarationSpan(declaration, declarationSource).start, declarationSpan(declaration, declarationSource).length);
  if (!declarationLocation) return null;
  const nodes = new Map<string, SymbolNode>();
  const relations: Omit<SymbolRelation, 'change'>[] = [];
  const addNode = (id: string, name: string, kind: string, loc: SymbolLocation) => {
    const previous = nodes.get(id);
    if (previous) { if (!previous.locations.some((item) => item.side === loc.side && item.path === loc.path && item.line === loc.line)) previous.locations.push(loc); }
    else nodes.set(id, { id, name, kind, locations: [loc] });
  };
  const add = (kind: SymbolRelation['kind'], from: string, to: string, label: string, loc: SymbolLocation,
    confidence: SymbolRelation['confidence'] = 'exact') => {
    if (relations.reduce((sum, item) => sum + item.locations.length, 0) >= 400)
      throw new AppError(422, '关系位置超过 400 处，请缩小仓库范围。');
    const id = `${kind}:${from}->${to}`;
    const previous = relations.find((item) => item.id === id);
    if (previous) previous.locations.push(loc);
    else relations.push({ id, kind, from, to, label, confidence, locations: [loc] });
  };
  addNode(selectedKey, symbol.getName(), ts.SyntaxKind[declaration.kind], declarationLocation);
  add('definition', selectedKey, selectedKey, '定义', declarationLocation);
  const references = service.findReferences(selected.getSourceFile().fileName, selected.getStart(source)) ?? [];
  let count = 0;
  for (const group of references) for (const ref of group.references) {
    if (++count > 400) throw new AppError(422, '精确引用超过 400 处，请缩小仓库范围。');
    if (ref.isDefinition) continue;
    const refSource = program.getSourceFile(ref.fileName);
    if (!refSource) continue;
    const loc = location(index, side, ref.fileName, refSource, ref.textSpan.start, ref.textSpan.length);
    const node = at(refSource, ref.textSpan.start, ref.textSpan.start + ref.textSpan.length);
    if (!loc || !node || isImport(node)) continue;
    const use = useKind(node);
    const owner = parentFunction(node);
    const ownerName = owner && declarationSpan(owner, refSource);
    let ownerSymbol = ownerName && checker.getSymbolAtLocation(at(refSource, ownerName.start, ownerName.start + ownerName.length) ?? owner!);
    if (ownerSymbol && ownerSymbol.flags & ts.SymbolFlags.Alias) ownerSymbol = checker.getAliasedSymbol(ownerSymbol);
    const ownerPoint = owner ? refSource.getLineAndCharacterOfPosition(owner.getStart(refSource)) : undefined;
    const ownerId = ownerSymbol && symbolKey(ownerSymbol) ||
      `${loc.path}::${functionName(owner)}@${ownerPoint ? `${ownerPoint.line + 1}:${ownerPoint.character + 1}` : 'top'}`;
    const ownerSpan = owner && declarationSpan(owner, refSource);
    const ownerLoc = ownerSpan && location(index, side, ref.fileName, refSource, ownerSpan.start, ownerSpan.length);
    addNode(ownerId, functionName(owner), 'caller', ownerLoc ?? loc);
    const isTest = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(loc.path);
    add(isTest ? 'test' : use, ownerId, selectedKey, isTest ? '测试引用' : use, loc);
    if (!isTest && memberBaseWrite(node)) add('read', ownerId, selectedKey, '读取对象并写入成员', loc);
  }
  // 出站关系只读选中函数体的一层调用，目标必须能由类型检查器定位到固定树中的定义。
  const body = ts.isFunctionLike(declaration) && 'body' in declaration ? declaration.body :
    ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isFunctionLike(declaration.initializer) &&
      'body' in declaration.initializer ? declaration.initializer.body : undefined;
  if (body) {
    let analyzed = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        if (ts.isIdentifier(target)) {
          let called = checker.getSymbolAtLocation(target);
          if (called && called.flags & ts.SymbolFlags.Alias) called = checker.getAliasedSymbol(called);
          const key = called && symbolKey(called);
          const loc = location(index, side, node.getSourceFile().fileName, node.getSourceFile(), target.getStart(), target.getWidth());
          const definition = called?.declarations?.[0];
          if (key && loc && definition) {
            const sourceFile = definition.getSourceFile();
            const span = declarationSpan(definition, sourceFile);
            const targetLoc = location(index, side, sourceFile.fileName, sourceFile, span.start, span.length);
            if (targetLoc) { addNode(key, called!.getName(), ts.SyntaxKind[definition.kind], targetLoc); add('outgoing_call', selectedKey, key, `调用 ${called!.getName()}`, loc); }
          } else if (loc) {
            const candidate = `candidate:${loc.path}:${loc.line}:${loc.column}`;
            addNode(candidate, target.text, '静态候选', loc);
            add('outgoing_call', selectedKey, candidate, `待核对调用 ${target.text}`, loc, 'static_candidate');
          }
        } else {
          const loc = location(index, side, node.getSourceFile().fileName, node.getSourceFile(), target.getStart(), Math.min(target.getWidth(), 40));
          if (loc) {
            const candidate = `candidate:${loc.path}:${loc.line}:${loc.column}`;
            addNode(candidate, target.getText().slice(0, 80), '文本候选', loc);
            add('outgoing_call', selectedKey, candidate, '动态调用待核对', loc, 'text_candidate');
          }
        }
      }
      if (ts.isIdentifier(node) && !isImport(node) &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node &&
            ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent)) {
        let dependency = checker.getSymbolAtLocation(node);
        if (dependency && dependency.flags & ts.SymbolFlags.Alias) dependency = checker.getAliasedSymbol(dependency);
        const key = dependency && symbolKey(dependency);
        const declaration = dependency?.declarations?.[0];
        const loc = location(index, side, node.getSourceFile().fileName, node.getSourceFile(), node.getStart(), node.getWidth());
        if (key && key !== selectedKey && declaration && loc && !declaration.getSourceFile().isDeclarationFile) {
          const definitionSource = declaration.getSourceFile();
          const span = declarationSpan(declaration, definitionSource);
          const definitionLoc = location(index, side, definitionSource.fileName, definitionSource, span.start, span.length);
          if (definitionLoc) {
            addNode(key, dependency!.getName(), ts.SyntaxKind[declaration.kind], definitionLoc);
            const kind = useKind(node);
            add(kind === 'incoming_call' ? 'read' : kind, selectedKey, key, `数据${kind}`, loc);
            if (memberBaseWrite(node)) add('read', selectedKey, key, '读取对象并写入成员', loc);
          }
        }
      }
      if (++analyzed > 10000) throw new AppError(422, '函数体过大，无法在资源上限内分析一层关系。');
      ts.forEachChild(node, visit);
    };
    visit(body);
  }
  const result = { name: symbol.getName(), token: selected.text, kind: ts.SyntaxKind[declaration.kind],
    type: checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, selected)), selectedKey,
    declarationLocation, nodes: [...nodes.values()], relations };
  return result;
  } finally { service.dispose(); }
}

export async function buildSymbolImpact(review: SavedReview, input: Selection): Promise<SymbolImpact> {
  const { snapshot } = review;
  if (snapshot.mode && snapshot.mode !== 'commits')
    throw new AppError(400, '影响链首期只支持两次提交或 GitLab MR 固定版本。');
  const file = snapshot.files.find((item) => input.side === 'before' ? item.oldPath === input.path : item.path === input.path);
  if ((!file && !input.expand) || !codeFile.test(input.path)) throw new AppError(400, '请选择当前 diff 中的 JS/TS 标识符。');
  const selectedText = input.side === 'before' ? file?.before : file?.after;
  if (selectedText === null) throw new AppError(400, '当前侧源码不可读取。');
  const indexed = await Promise.all([indexTree(snapshot.repo, snapshot.base), indexTree(snapshot.repo, snapshot.target)]);
  const [before, after] = indexed;
  const selectedIndex = input.side === 'before' ? before.files : after.files;
  const primary = collectSide(selectedIndex, input.side, input);
  if (!primary) throw new AppError(400, '选中内容无法定位到单一语义符号。');
  const otherSide: Side = input.side === 'before' ? 'after' : 'before';
  const otherPath = file ? (input.side === 'before' ? file.path : file.oldPath) : input.path;
  const other = collectSide(input.side === 'before' ? after.files : before.files,
    otherSide, { ...input, side: otherSide, path: otherPath },
    { token: primary.token, symbolName: primary.name, symbolKey: primary.selectedKey });
  const parts = [primary, other].filter((item): item is NonNullable<typeof item> => Boolean(item));
  const relationSides = new Map<string, Set<Side>>();
  for (const part of parts) for (const relation of part.relations) {
    const sides = relationSides.get(relation.id) ?? new Set<Side>();
    relation.locations.forEach((loc) => sides.add(loc.side));
    relationSides.set(relation.id, sides);
  }
  const nodes = new Map<string, SymbolNode>();
  const relations = new Map<string, SymbolRelation>();
  for (const part of parts) {
    for (const node of part.nodes) {
      const existing = nodes.get(node.id);
      if (existing) existing.locations.push(...node.locations);
      else nodes.set(node.id, { ...node, locations: [...node.locations] });
    }
    for (const relation of part.relations) {
      const existing = relations.get(relation.id);
      const change = relationSides.get(relation.id)?.size === 2 ? 'unchanged' :
        relation.locations[0].side === 'after' ? 'added' : 'removed';
      if (existing) existing.locations.push(...relation.locations);
      else relations.set(relation.id, { ...relation, change });
    }
  }
  return { snapshotId: snapshot.id,
    selected: { name: primary.name, kind: primary.kind, type: primary.type,
      locations: parts.map((item) => item.declarationLocation) },
    nodes: [...nodes.values()], relations: [...relations.values()],
    indexedFiles: before.files.size + after.files.size,
    limitations: [...before.limitations.map((item) => `修改前 ${item}`), ...after.limitations.map((item) => `修改后 ${item}`),
      '静态关系不证明运行时可达；动态属性、回调、事件总线、依赖注入和 React 状态需人工核对。',
      ...(other ? [] : ['另一侧未找到唯一同名定义，前后关系未自动配对。'])] };
}

// 相关文件回跳再次核对树成员和 blob OID，不能直接读取客户端传来的任意 Git 对象。
export async function readImpactSource(review: SavedReview, input: Pick<SymbolLocation, 'side' | 'path' | 'blobOid' | 'line'>): Promise<SourceRef> {
  const commit = input.side === 'before' ? review.snapshot.base : review.snapshot.target;
  if (review.snapshot.mode && review.snapshot.mode !== 'commits') throw new AppError(400, '此模式没有固定提交树。');
  if (!codeFile.test(input.path)) throw new AppError(400, '影响链只显示 JS/TS 固定源码。');
  const row = (await git(review.snapshot.repo,
    ['--literal-pathspecs', 'ls-tree', '-r', '-z', '-l', '--full-tree', commit, '--', input.path], 1024 * 1024))
    .toString('utf8').split('\0').find((item) => item.endsWith(`\t${input.path}`));
  const match = row && /^(\d{6}) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(row);
  if (!match || match[1] === '120000' || match[2] !== input.blobOid || Number(match[3]) > maxFileBytes)
    throw new AppError(409, '源码位置不属于当前固定快照或文件不可读取。');
  const bytes = await git(review.snapshot.repo, ['cat-file', 'blob', input.blobOid], maxFileBytes + 1024);
  if (bytes.includes(0)) throw new AppError(422, '二进制文件不可显示源码。');
  let body: string;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new AppError(422, '非 UTF-8 文件不可显示源码。'); }
  const lines = body.split('\n');
  if (input.line > lines.length) throw new AppError(409, '源码行号不属于当前固定版本。');
  const startLine = Math.max(1, input.line - 5);
  const endLine = Math.min(lines.length, input.line + 5);
  return { id: `symbol:${input.side}:${input.blobOid}:${input.line}`, side: input.side,
    path: input.path, blobOid: input.blobOid, startLine, endLine,
    code: lines.slice(startLine - 1, endLine).join('\n'), role: 'reference',
    label: `影响链固定源码 · L${input.line}` };
}
