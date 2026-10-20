# Errors and wire values

CanLang exposes typed outcomes through source, generated interfaces, and runtime adapters. Errors distinguish invalid source/value shape, safe business-rule rejection, missing or inaccessible records, stale versions, conflicts, retryable contention, and external delivery uncertainty. A caller should receive a stable safe category and useful authorized context, never SQL text, credentials, hidden record content, or an internal stack trace.

## Business errors

| Code | Meaning | HTTP status |
| --- | --- | --- |
| `validation` | Invalid input representation, bounds, or writable shape | 400 |
| `forbidden` | Caller fails operation admission | 403 |
| `not_found` | Missing, foreign, expired, or inaccessible target where disclosure must be withheld | 404 |
| `conflict` | Stale record version or conflicting reuse of operation identity | 409 |
| `rule_failed` | Authored guard, invariant, or lock rejects the change | 422 |
| `busy` | Retryable contention or blocked bounded disposal | 503 |
| `limit` | Bounded work/rate limit exceeded | 429 |
| `delivery_unknown` | External acceptance/outcome remains uncertain | 502 |

An inline example expects one exact code with `error(code)`; setup/compiler failures cannot stand in for that business rejection. Retry uncertain work with its original identity and inputs rather than minting a duplicate request.

## Requests and replay

Mutation request envelopes carry a stable UUIDv7 operation ID, canonical operation identity, arguments, and expected versions for record inputs. Omission remains distinct from explicit null in normalized inputs. The receipt hashes supplied inputs and retains successful resolved defaults separately. Replaying the same identity and inputs returns the saved outcome under current disclosure rules; reusing the identity with different inputs conflicts. Reads do not create mutation receipts.

## Canonical wire values

At the MCP/typed JSON boundary, all int and decimal values are canonical decimal strings, including money minor units and record versions; their JSON type never changes with magnitude. Protocol-owned counts remain protocol numbers.

| Value | JSON representation |
| --- | --- |
| int, decimal | Canonical decimal string |
| money | `{"minor":"1250","currency":"EUR"}` |
| date | `"2026-10-20"` |
| datetime | RFC3339 UTC instant, for example `"2026-10-20T09:00:00.000Z"` |
| record read input | `{"id":"opaque-id"}` |
| record mutation input | `{"id":"opaque-id","version":"1"}` |
| enum | Stable case string, without translated display labels |
| tagged union | `{"type":"QualifiedType","value":...}` |
| null, array | JSON null; ordered JSON array preserving duplicates |

Generated CRUD update uses `{record,changes,operation_id}`. Scenario business inputs are named alongside `operation_id`. Authentication, roles, and team grants are verified context, never user-supplied business arguments. Unknown arguments and undeclared writable fields fail. File references denote finalized opaque identities and cannot be replaced with a URL or arbitrary file-shaped object. Secret values are never client-readable.

Wire encodings preserve enum case identity, nullability, ordered arrays, duplicates, canonical reference identity, and exact money/time values. Invalid representations or unavailable codecs must fail explicitly rather than weaken constraints. Provider acceptance is not a domain success; represent pending, failed, delivered, or uncertain states according to the owning contract. See [transactions](../05-Workflows/03-transactions-and-concurrency.md), [deliveries](../07-Integrations/02-deliveries-and-recovery.md), and the [CLI reference](01-cli.md) for command exit behavior.
