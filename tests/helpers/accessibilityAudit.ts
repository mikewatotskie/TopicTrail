import ts from 'typescript';
import { resolve } from 'node:path';
import { androidRoleSets } from './accessibility';

const unknown = Symbol('unproven role');
const absent = Symbol('property absent');
type Value = string | number | boolean | null | undefined | typeof unknown | typeof absent;
const keys = ['accessibilityRole', 'role'] as const;
type Key = typeof keys[number];

/** Conservative source audit. Unknown roles fail; it does not prove arbitrary JS data flow. */
export function auditAccessibility(files: string[], virtual: Record<string, string> = {}) {
  const options: ts.CompilerOptions = { strict: true, skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true, esModuleInterop: true };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...rest) => Object.hasOwn(virtual, resolve(path))
    ? ts.createSourceFile(path, virtual[resolve(path)], languageVersion, true) : original(path, languageVersion, ...rest);
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();
  const native = androidRoleSets();
  const issues: string[] = [];
  let elements = 0, spreads = 0, assignments = 0;
  const unique = (items: Value[]) => [...new Set(items)];
  function literals(type: ts.Type): Value[] {
    if (type.isUnion()) return unique(type.types.flatMap(literals));
    if (type.isStringLiteral() || type.isNumberLiteral()) return [type.value];
    if (type.flags & ts.TypeFlags.Undefined) return [undefined];
    if (type.flags & ts.TypeFlags.Null) return [null];
    if (type.flags & ts.TypeFlags.BooleanLiteral) return [checker.typeToString(type) === 'true'];
    if (type.flags & ts.TypeFlags.Never) return [];
    return [unknown];
  }
  function initializer(node: ts.Node) {
    const symbol = checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) ? declaration.initializer : undefined;
  }
  function values(node: ts.Expression, os: string, seen = new Set<ts.Node>()): Value[] {
    if (seen.has(node)) return [unknown];
    const visited = new Set(seen).add(node);
    const read = (expression: ts.Expression) => values(expression, os, visited);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return read(node.expression);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isNumericLiteral(node)) return [Number(node.text)];
    if (node.kind === ts.SyntaxKind.NullKeyword) return [null];
    if (node.kind === ts.SyntaxKind.TrueKeyword) return [true];
    if (node.kind === ts.SyntaxKind.FalseKeyword) return [false];
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return [undefined];
      const init = initializer(node); if (init) return read(init);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'OS') {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const declaration = symbol?.declarations?.[0];
      if (declaration && ts.isImportSpecifier(declaration) && (declaration.propertyName?.text ?? declaration.name.text) === 'Platform'
        && declaration.parent.parent.parent.moduleSpecifier.getText().match(/['"]react-native['"]/)) return [os];
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return unique(read(node.operand).map(v => v === unknown ? unknown : !v));
    if (ts.isConditionalExpression(node)) return unique(read(node.condition).flatMap(v => v === unknown
      ? [...read(node.whenTrue), ...read(node.whenFalse)] : read(v ? node.whenTrue : node.whenFalse)));
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return unique(read(node.left).flatMap(v => v === unknown ? [unknown, ...read(node.right)]
          : (op === ts.SyntaxKind.AmpersandAmpersandToken ? !!v : op === ts.SyntaxKind.BarBarToken ? !v : v == null) ? read(node.right) : [v]));
      }
      if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(op)) {
        return unique(read(node.left).flatMap(a => read(node.right).map(b => a === unknown || b === unknown ? unknown
          : op === ts.SyntaxKind.EqualsEqualsEqualsToken ? a === b : a !== b)));
      }
    }
    return literals(checker.getTypeAtLocation(node));
  }
  function property(node: ts.Expression, key: Key, os: string, seen = new Set<ts.Node>()): Value[] {
    if (seen.has(node)) return [unknown];
    const visited = new Set(seen).add(node);
    const read = (expression: ts.Expression) => property(expression, key, os, visited);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return read(node.expression);
    if (ts.isIdentifier(node)) { const init = initializer(node); if (init) return read(init); }
    if (ts.isConditionalExpression(node)) return unique(values(node.condition, os).flatMap(v => v === unknown
      ? [...read(node.whenTrue), ...read(node.whenFalse)] : read(v ? node.whenTrue : node.whenFalse)));
    if (ts.isObjectLiteralExpression(node)) {
      let result: Value[] = [absent];
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) { result = merge(result, read(item.expression)); continue; }
        const names: Value[] = item.name && ts.isComputedPropertyName(item.name) ? values(item.name.expression, os)
          : item.name ? [item.name.getText().replace(/^['"]|['"]$/g, '')] : [unknown];
        if (names.includes(key)) result = ts.isPropertyAssignment(item) ? values(item.initializer, os)
          : ts.isShorthandPropertyAssignment(item) ? values(item.name, os) : [unknown];
        else if (names.includes(unknown)) result = [unknown];
      }
      return result;
    }
    function typed(type: ts.Type): Value[] {
      if (type.isUnion()) return unique(type.types.flatMap(typed));
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return [unknown];
      const prop = type.getProperty(key);
      if (prop) {
        const result = literals(checker.getTypeOfSymbolAtLocation(prop, node));
        if (prop.flags & ts.SymbolFlags.Optional) result.push(absent);
        return unique(result);
      }
      return type.getStringIndexType() ? [unknown] : [absent];
    }
    return typed(checker.getTypeAtLocation(node));
  }
  function merge(previous: Value[], next: Value[]) { return unique(next.flatMap(value => value === absent ? previous : [value])); }
  for (const path of files) {
    const source = program.getSourceFile(path)!;
    function check(node: ts.Node, get: (key: Key, os: string) => Value[], webOnly: boolean) {
      for (const os of webOnly ? ['web'] : ['android', 'web']) for (const key of keys) {
        const allowed = os === 'android' ? native[key] : [...native.role, ...native.accessibilityRole];
        const bad = get(key, os).filter(value => value !== absent && value != null
          && (typeof value !== 'string' || !allowed.includes(value.toLowerCase())));
        if (bad.length) issues.push(`${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${os} ${key}: ${bad.map(v => v === unknown ? 'UNPROVEN' : String(v)).join(', ')}`);
      }
    }
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        elements++;
        spreads += node.attributes.properties.filter(ts.isJsxSpreadAttribute).length;
        assignments += node.attributes.properties.filter(item => ts.isJsxAttribute(item) && keys.includes(item.name.getText() as Key)).length;
        check(node, (key, os) => {
          let result: Value[] = [absent];
          for (const item of node.attributes.properties) {
            if (ts.isJsxSpreadAttribute(item)) result = merge(result, property(item.expression, key, os));
            else if (item.name.getText() === key) {
              const value = item.initializer;
              result = !value ? [true] : ts.isStringLiteral(value) ? [value.text]
                : ts.isJsxExpression(value) ? value.expression ? values(value.expression, os) : [undefined] : [unknown];
            }
          }
          return result;
        }, /\.web\.[jt]sx?$/.test(path) || /^[a-z]/.test(node.tagName.getText()));
      }
      if (ts.isCallExpression(node) && /^(React\.)?createElement$/.test(node.expression.getText()) && node.arguments[1]) {
        elements++;
        check(node, (key, os) => property(node.arguments[1], key, os), /\.web\.[jt]sx?$/.test(path));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { files: files.length, elements, spreads, assignments, issues };
}
