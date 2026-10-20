# Localization

Localization presents messages in a viewer language while preserving canonical values, identities, permissions and operation results.

## Messages and fallback

Author messages and labels with the language owner’s inline translation form. Resolve the browser language from the saved viewer preference, then its language priority list, then the application default. Each complete message uses RFC 4647 lookup for the selected locale, then app-default lookup, then its owning source variant, skipping absent translations. An empty translation remains valid text; null means absent. Formatting/plural rules follow the selected variant’s language. ICU parameters are typed values and are formatted for display; do not concatenate untrusted content into markup.

Localization changes presentation only. It does not change enum identity, judgment inputs, policy, stored values or business comparisons. Outbound email and other durable communications should freeze the reviewed wording and recipient at the operation boundary. MCP descriptions remain in their source language under the accepted contract. See [types and values](../02-Language/03-types-and-values.md) and [email](../07-Integrations/04-email-and-mailboxes.md).
