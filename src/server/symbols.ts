import path from 'node:path';
import ts from 'typescript';

export interface ChangedSymbol {
  path: string;
  name: string;
  startLine: number;
  endLine: number;
  changeIds: string[];
}

export interface StaticReference {
  path: string;
  line: number;
  symbol: string;
  changeIds: string[];
}

const virtualRoot = '/__review_snapshot__';
const virtualPath = (filePath: string) => path.posix.join(virtualRoot, filePath);

function isImportPosition(source: ts.SourceFile, position: number): boolean {
  let nested: ts.Node = source;
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, (child) => {
      if (child.getStart(source) <= position && position < child.getEnd()) {
        nested = child;
        visit(child);
      }
    });
  };
  visit(source);
  for (let node: ts.Node | undefined = nested; node; node = node.parent)
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return true;
  return false;
}

// 仅以固定快照的有限文本构造语言服务；查到的是静态符号引用，绝不代表运行时可达。
export function findStaticReferences(
  sources: Map<string, string>,
  declarations: ChangedSymbol[],
  limit = 30,
): StaticReference[] {
  const files = new Map([...sources].map(([filePath, text]) => [virtualPath(filePath), text]));
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
    }),
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const text = files.get(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => virtualRoot,
    getDefaultLibFileName: () => `${virtualRoot}/lib.d.ts`,
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    directoryExists: (directory) =>
      directory === virtualRoot ||
      [...files.keys()].some((file) => file.startsWith(`${directory}/`)),
    readDirectory: () => [],
  };
  const service = ts.createLanguageService(host);
  const found = new Map<string, StaticReference>();
  try {
    const program = service.getProgram();
    if (!program) return [];
    for (const declaration of declarations) {
      const filename = virtualPath(declaration.path);
      const source = program.getSourceFile(filename);
      if (!source) continue;
      let namePosition: number | undefined;
      const visit = (node: ts.Node): void => {
        if (namePosition !== undefined) return;
        const name =
          ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
            ? node.name
            : ts.isVariableDeclaration(node) &&
              node.initializer &&
              (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
            ? node.name
            : undefined;
        if (name && ts.isIdentifier(name) && name.text === declaration.name) {
          const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const end = source.getLineAndCharacterOfPosition(node.getEnd() - 1).line + 1;
          if (start <= declaration.endLine && end >= declaration.startLine)
            namePosition = name.getStart(source);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (namePosition === undefined) continue;
      for (const group of service.findReferences(filename, namePosition) ?? []) {
        for (const reference of group.references) {
          if (reference.isDefinition || reference.fileName === filename) continue;
          const caller = program.getSourceFile(reference.fileName);
          if (!caller || isImportPosition(caller, reference.textSpan.start)) continue;
          const filePath = reference.fileName.slice(virtualRoot.length + 1);
          const line = caller.getLineAndCharacterOfPosition(reference.textSpan.start).line + 1;
          const key = `${filePath}:${line}:${declaration.name}`;
          const existing = found.get(key);
          if (existing) {
            existing.changeIds = [...new Set([...existing.changeIds, ...declaration.changeIds])];
          } else {
            found.set(key, {
              path: filePath,
              line,
              symbol: declaration.name,
              changeIds: declaration.changeIds,
            });
          }
          if (found.size >= limit) return [...found.values()];
        }
      }
    }
    return [...found.values()];
  } finally {
    service.dispose();
  }
}
