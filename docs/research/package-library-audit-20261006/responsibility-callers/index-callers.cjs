// Read-only syntax index. Calls/imports are evidence candidates, never reachability verdicts.
const ts = require('typescript');
const path = require('node:path').posix;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  const packet = JSON.parse(input);
  for (const pkg of packet.packages) {
    const parsed=ts.parseConfigFileTextToJson(pkg.directory + '/tsconfig.json', pkg.config_text);
    if (parsed.error) throw Error('Cannot parse pinned package config: ' + pkg.directory);
    pkg.rootDir=parsed.config.compilerOptions?.rootDir || '.';
    pkg.outDir=parsed.config.compilerOptions?.outDir || 'dist';
    delete pkg.config_text;
  }
  const entries = new Map(packet.files.map(file => [file.path, file]));
  const known = new Set(packet.known_paths || entries.keys());
  const virtual = '/__can_audit__/';
  const sources = new Map(packet.files.map(file => [virtual + file.path,
    ts.createSourceFile(virtual + file.path, file.text, ts.ScriptTarget.Latest, true)]));
  const host = {getSourceFile: name => sources.get(name), getDefaultLibFileName: () => '',
    writeFile() { throw Error('Audit must not emit'); }, getCurrentDirectory: () => virtual,
    getDirectories: () => [], fileExists: name => sources.has(name), readFile: () => undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n'};
  const program = ts.createProgram([...sources.keys()], {allowJs:true, noResolve:true, noLib:true, types:[]}, host);
  const checker = program.getTypeChecker();
  const flatten = (value, conditions = []) => typeof value === 'string' ? [{target:value, conditions}] :
    value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => flatten(child, [...conditions, key])) : [];
  const owner = file => packet.packages.find(pkg => file.startsWith(pkg.directory + '/'));
  function sourceTarget(file) {
    const candidates = [file, file.replace(/\.d\.[cm]?ts$/, '.ts'), file.replace(/\.[cm]?js$/, '.ts'), file.replace(/\.mjs$/, '.mts')];
    const pkg = owner(file);
    if (pkg && file.startsWith(pkg.directory + '/' + pkg.outDir + '/')) {
      const tail = file.slice((pkg.directory + '/' + pkg.outDir + '/').length);
      const root = path.normalize(pkg.directory + '/' + pkg.rootDir + '/' + tail);
      candidates.push(root, root.replace(/\.d\.[cm]?ts$/, '.ts'), root.replace(/\.[cm]?js$/, '.ts'));
    }
    return candidates.find(candidate => known.has(candidate)) || null;
  }
  function resolve(file, specifier) {
    if (specifier.startsWith('.')) return [{path:sourceTarget(path.normalize(path.dirname(file) + '/' + specifier)), conditions:[]}];
    const pkg = specifier.startsWith('#') ? owner(file) : packet.packages.find(x => specifier === x.name || specifier.startsWith(x.name + '/'));
    if (!pkg) return [];
    const key = specifier.startsWith('#') ? specifier : '.' + specifier.slice(pkg.name.length);
    const table = specifier.startsWith('#') ? pkg.imports : pkg.exports;
    return flatten(table[key]).map(({target, conditions}) => ({path:sourceTarget(path.normalize(pkg.directory + '/' + target)), declared_target:target, conditions}));
  }
  const edges = [], uses = [], dynamic = [];
  for (const [name, source] of sources) {
    const file = name.slice(virtual.length), imported = new Map();
    const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const literal = (node, seen = new Set()) => {
      if (!node || seen.has(node)) return null;
      seen.add(node);
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literal(node.expression, seen);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const a=literal(node.left,seen), b=literal(node.right,seen); return a===null || b===null ? null : a+b;
      }
      if (ts.isIdentifier(node)) {
        const declarations = checker.getSymbolAtLocation(node)?.declarations || [];
        const declaration = declarations.find(x => ts.isVariableDeclaration(x) && (x.parent.flags & ts.NodeFlags.Const));
        return declaration ? literal(declaration.initializer, seen) : null;
      }
      return null;
    };
    function edge(node, specifier, kind, typeOnly, bindings=[]) {
      const row = {file,line:line(node),specifier,kind,type_only:!!typeOnly,targets:resolve(file,specifier)};
      edges.push(row);
      for (const [identifier, original, bindingTypeOnly] of bindings) {
        const symbol = checker.getSymbolAtLocation(identifier);
        if (symbol) imported.set(symbol,{edge:edges.length-1,original,type_only:!!typeOnly || !!bindingTypeOnly});
      }
    }
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const bindings = [], clause=statement.importClause;
        if (clause?.name) bindings.push([clause.name,'default',false]);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.push([clause.namedBindings.name,'*',false]);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) bindings.push([item.name,item.propertyName?.text || item.name.text,item.isTypeOnly]);
        edge(statement,statement.moduleSpecifier.text,'import',clause?.isTypeOnly,bindings);
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        const allTypes = statement.isTypeOnly || (statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.every(x => x.isTypeOnly));
        edge(statement,statement.moduleSpecifier.text,'reexport',allTypes);
      }
    }
    function walk(node) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = literal(node.arguments[0]);
        if (specifier !== null) edge(node,specifier,'dynamic-import',false);
        else dynamic.push({file,line:line(node),expression:node.arguments[0]?.getText(source).slice(0,180),kind:'unresolved-dynamic-import'});
      }
      if (ts.isIdentifier(node)) {
        const binding=imported.get(checker.getSymbolAtLocation(node));
        if (binding && !ts.isImportSpecifier(node.parent) && !ts.isNamespaceImport(node.parent) && !ts.isImportClause(node.parent)) {
          let ancestor=node.parent, isType=binding.type_only;
          while (ancestor && !ts.isStatement(ancestor)) { if (ts.isTypeNode(ancestor)) isType=true; ancestor=ancestor.parent; }
          let expression=node;
          if (ts.isPropertyAccessExpression(node.parent) && node.parent.expression===node) expression=node.parent;
          const invoked=(ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent)) && expression.parent.expression===expression;
          uses.push({file,line:line(node),edge:binding.edge,symbol:binding.original==='*' && ts.isPropertyAccessExpression(expression) ? expression.name.text : binding.original,
            use:isType ? 'type-reference' : invoked ? 'call-or-construction' : 'value-reference'});
        }
      }
      ts.forEachChild(node,walk);
    }
    walk(source);
  }
  const apiTargets = packet.packages.flatMap(pkg => Object.entries(pkg.exports).map(([key,value]) => ({
    owner:pkg.name,key,targets:flatten(value).map(({target,conditions}) => ({declared_target:target,
      path:sourceTarget(path.normalize(pkg.directory + '/' + target)),conditions}))
  })));
  process.stdout.write(JSON.stringify({typescript:ts.version,edges,uses,dynamic,package_targets:packet.packages,api_targets:apiTargets}));
});
