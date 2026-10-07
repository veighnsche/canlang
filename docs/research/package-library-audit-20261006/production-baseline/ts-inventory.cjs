// Audit only: parse pinned blobs; never resolve modules or emit product code.
const ts = require('typescript');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
  const files = JSON.parse(input).map(({path, text}) => {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    // Use LF physical lines consistently with Git, not JS Unicode line terminators.
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const line = pos => {
      let lo = 0, hi = starts.length;
      while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid; }
      return lo + 1;
    };
    const definitions = [], exports = [];
    for (const node of source.statements) {
      const modifiers = ts.getModifiers(node) || [];
      const declared = modifiers.some(x => x.kind === ts.SyntaxKind.DeclareKeyword);
      const importTypes = ts.isImportDeclaration(node) && node.importClause &&
        (node.importClause.isTypeOnly || (!node.importClause.name && node.importClause.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 &&
          node.importClause.namedBindings.elements.every(x => x.isTypeOnly)));
      const exportTypes = ts.isExportDeclaration(node) && (node.isTypeOnly ||
        (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every(x => x.isTypeOnly)));
      const definition = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || declared ||
        importTypes || exportTypes || (ts.isFunctionDeclaration(node) && !node.body);
      const first = line(node.getStart(source)), last = line(Math.max(node.getStart(source), node.end - 1));
      // Mixed-line statements remain implementation: don't discard executable code on the same line.
      if (definition && !source.statements.some(other => other !== node &&
          line(other.getStart(source)) <= last && line(Math.max(other.getStart(source), other.end - 1)) >= first)) {
        definitions.push([first, last]);
      }
      const exported = modifiers.some(x => x.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) {
        const names = ts.isVariableStatement(node) ? node.declarationList.declarations.map(x => x.name.getText(source)) :
          [node.name ? node.name.getText(source) : 'default'];
        const domain = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? 'type' :
          definition ? 'declaration' : 'value';
        for (const name of names) exports.push([first, ts.SyntaxKind[node.kind], name.replace(/\s+/g, ' '), domain, '']);
      } else if (ts.isExportDeclaration(node)) {
        exports.push([first, 'ReExport', node.exportClause ? node.exportClause.getText(source).replace(/\s+/g, ' ') : '*',
          exportTypes ? 'type' : 'unresolved', node.moduleSpecifier ? node.moduleSpecifier.text : '']);
      } else if (ts.isExportAssignment(node)) exports.push([first, 'ExportAssignment', 'default', 'value', '']);
    }
    return {path, definitions, exports, parse_errors: source.parseDiagnostics.map(x => [x.start, x.code])};
  });
  process.stdout.write(JSON.stringify({typescript: ts.version, files}));
});
