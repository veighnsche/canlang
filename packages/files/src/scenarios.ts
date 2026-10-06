/**
 * Files scenario tables (S9a): there are none, by construction.
 *
 * Files has no provider: bytes are test-supplied, storage is real
 * local (`BlobStorePort`), and every files failure (conflicting
 * bytes, drifted staging, expired intents, oversize appends, foreign
 * refs, cross-principal/team denial, GC horizon) is deterministic
 * kernel logic over a working store — B2 journeys drive the real
 * operations and assert outcomes directly, with no transport to
 * script. Blob-seam fault injection (failing writes, dropped keys)
 * would be new untested surface: the kernel does not classify blob
 * throws today, so no such vocabulary is invented here. If a B2
 * journey needs it, that is a named gap with a kernel-handling
 * prerequisite, not a table to author ahead.
 *
 * Byte-fixture authority for B2 journeys (values, not imports —
 * fixtures live test-side in `test/helpers.ts`): PDF `%PDF-1.4`,
 * PNG 8-byte magic, JPEG `FF D8 FF` magic, plain text, 4 garbage
 * bytes, truncated 4-byte PNG.
 */
import type { ScenarioTable } from '@canlang/services/scenarios';

/** Files authors no scenario tables; the list is pinned empty. */
export const FILES_SCENARIO_TABLES: readonly ScenarioTable[] = [];
