# Styles and custom views

Generated presentation is scoped CSS or a checked renderer attached to an ordinary reusable view/component; it cannot change data access or business behavior.

## Styles

A top-level `style Name $"prompt"` defines a reusable style in the owning namespace. A component attaches one inline prompt or named style suffix; named uses share the definition’s CSS and receive separate instance hooks. Incompatible ownership or part contracts fail validation. Styles cannot escape their local scope, import remote assets or redefine global theme variables.

## Custom views

A custom renderer extends same-module `view Name(row: Model)` and `show Name {row=expression}`. The renderer prompt appears in the view header; an optional second style suffix styles the root. The row is one required nonnullable stored-model value, evaluated once. Renderer output uses only checked inputs and canonical action bindings. Browser interaction code is separate from server rendering and receives admitted presentation data only.

Ordinary reusable views need no generation. Generated code is saved and editable; see [generation lifecycle](01-generation-lifecycle.md), [interfaces](../06-Interfaces/02-collections-and-views.md), and [components](../06-Interfaces/04-components-and-layout.md).
