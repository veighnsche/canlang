/** Portable manifest/configuration checks; editor-theme palette audits stay local. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8'));
const manifest = read('package.json');
const grammar = read('syntaxes/can.tmLanguage.json');
const config = read('language-configuration.json');
assert.equal(manifest.contributes.languages[0].configuration, './language-configuration.json');
assert.equal(manifest.contributes.grammars[0].scopeName, grammar.scopeName);
assert.equal(config.comments.lineComment, '##');
assert.deepEqual(config.brackets, [['{', '}'], ['[', ']'], ['(', ')']]);
assert.deepEqual(config.autoClosingPairs.map(({ open, close }) => [open, close]),
  [...config.brackets, ['"', '"']]);
assert(config.autoClosingPairs.every(({ notIn }) => notIn.includes('string') && notIn.includes('comment')));
assert.equal(manifest.contributes.configurationDefaults['[can]']['editor.tabSize'], 1);
const increase = new RegExp(config.indentationRules.increaseIndentPattern);
const decrease = new RegExp(config.indentationRules.decreaseIndentPattern);
for (const line of ['Given', 'When', 'Then', ' Given', ' When', ' Then', 'package Shared', 'package Shared source="en"', ' scenario complete(task:Todo) by=members', ' page / title="Todos"', '  do']) {
  assert(increase.test(line), `indent after ${line}`);
}
for (const line of [' ## Given', ' # do', ' title "do"', '   let count=1', '  do return task', ' label "scenario name"']) {
  assert(!increase.test(line), `keep indentation after ${line}`);
}
for (const line of ['Given', 'When', 'Then']) assert(decrease.test(line), `section boundary ${line}`);
for (const line of [' Given', ' When', ' Then', '  do', ' ## When', '  ThenValue']) assert(!decrease.test(line));
assert(increase.test('package Shared'), 'Enter after package adds the first indentation level');
assert(!decrease.test(' Given'), 'first nested Given preserves package indentation');
assert(increase.test(' Given'), 'Enter after nested Given adds the declaration indentation level');
console.log('PASS portable Can grammar manifest, comment/bracket pairs and contextual indentation');
