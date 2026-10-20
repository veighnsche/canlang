# Descriptions and generated app reference

Attach business meaning to source declarations, distinguish descriptions from comments, and reuse localized metadata in the application reference generated from checked source.

## Attach descriptions to declarations

Descriptions are authored metadata attached to eligible declarations. A leading `#` line describes the next declaration at the same indentation; consecutive lines join. `##` comments are explanatory source comments and are not descriptions. A declaration has one description slot, so do not combine attached prose with an inline `desc=` on the same field or parameter.

## Reuse and localize descriptions

Static messages can be reused with the grammar's `#= path` form when the declaration contract permits it. Localized description variants belong to the declaration's source language identity; they are not runtime interpolation. Reusable messages and translations have their own source forms in the [syntax reference](../13-Language-reference/01-syntax-reference.md).

## Generate reference from the owning contract

Good descriptions state business meaning, especially for public operations, exposed reports, fields, and UI labels. Generated application reference material is derived from checked declarations and their descriptions. It cannot document unstated policy accurately; keep the source description close to the owning contract. For exact attachment rules, see [source syntax](01-source-syntax.md).
