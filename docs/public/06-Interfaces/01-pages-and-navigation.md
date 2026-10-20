# Pages and navigation

Pages define the admitted destinations and the view each destination serves. The shared dispatcher checks the page admission rules on direct and partial requests; a link or navigation item never grants access. Navigation is derived from eligible declarations for the current caller and team.

## Shared shell

The shared application shell has a collapsible left sidebar page menu, bottom-left user menu, common user configuration dialog and login screen; mobile adapts the same shell to an accessible drawer. Page-local navigation components do not select a different shell layout. The shell owns account controls, settings entry and page framing. Compose destinations from declared pages; do not duplicate route lists in a second registry. `navbar`, `menu`, `megamenu`, `dock`, `link` and `breadcrumbs` present those destinations. The breadcrumb ancestry is derived from the declared route.

A missing or newly forbidden destination disappears from discovery, and direct requests are checked again. Membership, team selection and policy changes invalidate earlier eligibility. See [roles and operation permissions](../04-Access-and-rules/02-roles-and-operation-permissions.md), [read policies](../04-Access-and-rules/03-read-policies-and-field-access.md), and [layout components](../12-Reference/09-components-layout-and-navigation.md).

## Composition

Use a page for a routable screen and reusable views for repeated presentation. Collection detail, forms and canonical actions should stay attached to their owning page or record context. The shell supplies the frame; generated renderers return page content rather than a competing shell.
