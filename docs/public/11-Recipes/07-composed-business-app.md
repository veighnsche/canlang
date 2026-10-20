# Composed business app

Combine independently owned applications while preserving each module's identity, access policy and explicit public interface.

Choose modules around clear business ownership, such as expenses, projects and people. Each module owns its records and operations. The composing application selects the modules and wires admitted public declarations; it does not gain access to every private record or operation merely by including a package.

Use explicit references or operation bindings exposed by the owning module. Keep cross-module writes inside an operation that declares the intended coordination and failure behavior. A commit at one owner does not make a remote service or second owner part of the same atomic transaction. Use durable intent and reconciliation for cross-owner work.

Review the composed app's effective navigation and permissions as a whole. Confirm that users can reach each workflow while still being denied data they do not own. Conflicting defaults or incompatible contracts should be resolved at composition, not hidden by an alias.

Test module-local permissions and joined journeys, including a failure after the first owner commits. Verify retry is idempotent and the app can show pending reconciliation. This page is a composition guide; the exact module and import forms belong to [apps and packages](../02-Language/02-apps-and-packages.md). See [external connections](../07-Integrations/06-external-data-and-app-connections.md) and [transactions](../05-Workflows/03-transactions-and-concurrency.md).
