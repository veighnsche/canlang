"""Create an inspectable production index for this audit; not a parser or test framework."""
from pathlib import Path
import re,csv
base=Path(__file__).parent
text=(base/'snapshot/GRAMMAR.md').read_text().splitlines()
families=[
 (16,22,'Lexical tokens / paths','string, punctuation, expression/type-content name rules','numeric-string-boundaries; identifier-after-keyword','Common literals/escapes covered; contextual paths require slot-aware treatment; malformed syntax is not diagnosed.'),
 (130,151,'Files / composition / sections / imports','statements declaration/import/section rules; generic expression','sections-and-identifiers; context-settings; full-contextual-model-names','Ordered owner/section grammar not tracked; context model collision; unresolved import/member roles intentionally cannot be inferred.'),
 (163,173,'Types / schemas / signatures','type, type-content, result-type, field, parameter, signature-parens','multiline-union-and-types; type-contextual-names; multiline-type-reserved-arms; whitespace-stable-types-and-calls','Explicit roles substantially covered; contextual union arms and multiline modifier-shaped type names fail; whitespace-separated array suffix lacks modifier scope.'),
 (191,215,'Expressions / values / calls','expression, code, parens, array, object, punctuation','typed-values; expression-contextual-operators; multiline-values-shorthand; whitespace-stable-types-and-calls','No complete operand/query state; typed constructor role improved in 0.1.2; multiline shorthand and cross-line call roles differ; precedence/typing are outside highlighter.'),
 (229,235,'Query tails and extents','expression/code lookbehind query patterns and generic property key','query-newlines; query-contextual-domain; contextual-query-binders','Multiline clauses and contextual preceding identifiers lose query/operator roles; order= remains property-key; alias lifetime is not validated.'),
 (249,268,'Given declarations / resources / constraints','statements plus shared schema/expression rules; capability region','roles-of-declarations; qualified-derived-field; context-settings; capability-leaves; full-contextual-model-names','Declaration roles improved in 0.1.2; broad statement/model patterns ignore section context; secondary capability signature is call-scoped; permission/constraint meaning not checked.'),
 (278,291,'Messages / captions / label maps / locales','markers, variants, string, generic object/property key','schema-prose-and-variants; identifier-after-keyword','JSON strings, suffix, basic keys covered; closed label schemas and attachment not validated; quoted locale key has ordinary string scope.'),
 (305,332,'When / guards / effects / control','statements plus signature-parens/result-type/expression','effects-and-reference-targets; effect-versus-model-brace; contextual-query-binders; semicolons','Plain effect paths improved in 0.1.2; return-object and loop contextual-name collisions; parenthesized targets lose operation role; authority/execution correctness outside scope.'),
 (346,353,'Behavior examples / table cells','examples statement rule and generic code expressions','crud-example-actions; sections-and-identifiers','No examples region: header/cell names may become presentation keywords; CRUD action fallback variable; -> and calls colored but no test execution or selector validation.'),
 (363,393,'Presentation / routes / selectors / ordering','statements page and UI rules; object/array/expression','presentation-reference-roles; routes-all-type-shapes; identifier-after-keyword','New attrs/maps receive generic colors; selectors not role-scoped; actions/review/refresh references missed; route type internals flattened; permissions unresolved.'),
 (405,419,'Maintenance / migration / backfills','statements rename/owner/control rules plus expression','maintenance','Rename fields flattened into type; backfill model reference variable; directive shape/pure mapper limits and migration execution not validated.')]
rows=[];ebnf=False
for number,line in enumerate(text,1):
 if line=='```ebnf':ebnf=True;continue
 if line=='```':ebnf=False
 if not ebnf:continue
 match=re.match(r'^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)',line)
 if not match:continue
 family=next(x for x in families if x[0]<=number<=x[1])
 rows.append(dict(production=match[1],grammar_line=number,family=family[2],extension_repository_rules=family[3],focused_probe_ids=family[4],coverage_and_limits=family[5]))
with (base/'production-coverage.csv').open('w') as f:
 w=csv.DictWriter(f,fieldnames=rows[0]);w.writeheader();w.writerows(rows)
print(f'{len(rows)} explicit EBNF productions indexed. This is inventory coverage, not correctness coverage.')
