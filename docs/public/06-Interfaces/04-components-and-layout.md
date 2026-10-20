# Components and layout

Compose the finite approved component vocabulary around source-owned data and actions. Components control presentation and interaction; they do not create schemas, permissions or business operations.

## Composition rules

Use explicit component children and declared slots. A slotted group requires its required slots exactly once; repeatable item slots follow the declared sequence. Bind controls to the nearest checked field, view state or canonical action context. Unknown attributes and unsupported appearance values are errors, not arbitrary HTML escape hatches.

Keep headings, labels and accessible names meaningful. Preserve keyboard operation, visible focus, contrast and reduced-motion behavior. Dynamic values are escaped as text unless the owning component explicitly accepts a safe, authorized media reference. Responsive composition should retain the same meaning and actions at narrow widths.

Component-specific signatures and bindings live in [layout and navigation](../12-Reference/09-components-layout-and-navigation.md), [content and feedback](../12-Reference/10-components-content-and-feedback.md), [inputs](../12-Reference/11-components-inputs.md), [disclosure and actions](../12-Reference/12-components-disclosure-and-actions.md), and [collections and media](../12-Reference/13-components-collections-and-media.md).
