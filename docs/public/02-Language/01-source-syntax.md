# Source layout and syntax

CanLang source uses explicit `Given`, `When`, and `Then` sections to declare data and rules, operations, and presentation. An implicit app has one ordered section triple. A package uses the same triple indented beneath `package NAME`. Blank lines and comments aid reading but do not introduce executable bindings.

## A complete minimal source file

```can
# Track team tasks.
app Tasks
Given
 Todo { title:text }
When
Then
 page / title="Tasks"
```

Indentation defines suites; use one space per level. Declarations and fields use braces where the grammar calls for schemas. `#` lines attach prose descriptions to the next eligible declaration at the same column; `##` lines are explanatory comments discarded by the parser. Inline hash comments are not valid. Strings use quoted literals; `true`, `false`, and `null` are values. Expressions and query tails have defined grammar and precedence—see [expressions and derives](04-expressions-and-derives.md).

The sample is a complete minimal app with an empty operation section. A snippet taken from a section is a fragment and needs an owning app/package and all referenced declarations. The [syntax reference](../12-Reference/06-syntax-reference.md) indexes productions; this page explains layout rather than duplicating every signature.
