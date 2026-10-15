# CanLang handbook

CanLang is an AI-native language for custom business applications: describe your records, authority, business behavior and interfaces in compact `.can` source.

## One application, connected parts

A business application needs more than a set of forms. It needs to decide who can see a record, who can change it, what transitions are allowed, and what happens when an update is stale or an external delivery is uncertain. CanLang expresses those decisions together.

Every application has three ordered sections:

| Section | What you declare | Typical contents |
| --- | --- | --- |
| `Given` | Facts and rules | Models, types, read policies, invariants and fixtures |
| `When` | Permitted behavior | CRUD, scenarios and event handlers |
| `Then` | Presentation | Pages, forms, lists and preferences |

The same operations supply browser forms and MCP tools. Changing a permission changes the authority of the operation behind those interfaces. A hidden button alone is never an authorization rule.

## Designed for AI authoring

Canonical business primitives and shared defaults keep source small enough for a coding agent to work with directly. Ask an agent for an application, inspect its business decisions, and use compiler diagnostics and executable examples to improve the source. The language owns syntax and authority; natural-language descriptions explain intent.

CanLang also supports explicit build-time generation for selected traits, keywords, styles and views. Generated implementations are saved and validated. An ordinary build reuses saved output without invoking a model. [Services and generation](../02-Language/06-services-and-generation.md) explains the distinction between build-time code generation and provider calls made by an application.

## A focused application model

CanLang targets CRUD-centered business software with bounded workflows: approvals, scheduling, files, reporting, external synchronization and reviewed AI results. The standard application model supplies authentication, teams, storage and shared interface behavior. You declare the business permissions and rules.

The selected runtime architecture uses workerd, Cloudflare D1, Durable Objects when required, R2 for files, and a shared daisyUI/HTMX browser interface. Source composition determines application ownership and dependencies. You do not need to repeat those defaults in every app.

Use CanLang where typed records, explicit authority and reusable business behavior are a good fit. Its standard interface vocabulary supplies business UI; arbitrary app-level HTML, CSS and JavaScript are outside the v1 authoring model. Generated extension points have their own checked contracts.

## Your first steps

[Install the tools and write Tasks](02-installation.md), then learn [how source ownership works](../02-Language/01-source-and-composition.md). Begin with a small complete workflow, including a permitted user, a denied user and a stale update. Expand it as the company's real rules become clear.

## Handbook chapters

- [Installation and first app](02-installation.md)
- [Source and composition](../02-Language/01-source-and-composition.md)
- [Data and queries](../02-Language/02-data-and-queries.md)
- [Permissions and business rules](../02-Language/03-permissions.md)
- [Workflows and events](../02-Language/04-workflows.md)
- [Interfaces and localization](../02-Language/05-interfaces.md)
- [Services and generation](../02-Language/06-services-and-generation.md)
- [Local development](../03-Build-and-operate/01-local-development.md)
- [Testing](../03-Build-and-operate/02-testing.md)
- [Deployment and maintenance](../03-Build-and-operate/03-deployment.md)
- [CLI and language reference](../04-Reference/01-cli.md)
