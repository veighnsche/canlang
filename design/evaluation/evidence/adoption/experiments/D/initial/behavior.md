# Independently authored acceptance expectations

These are intended business outcomes, not a report of execution.

1. Employee A enters “  Laptop  ” and a note: resulting title is “Laptop”, owner is A, department comes from A's current membership, state open/version1. A client cannot name another owner or department.
2. A edits their own open request using displayed version1: new claims are saved as version2 with attributable evidence. A second edit using version1 produces conflict and does not overwrite the newer claims.
3. Employee B reads/edits/archives A's request: no record content is disclosed and no mutation occurs. Ordinary peer membership grants no department-wide visibility.
4. A manager assigned department A can read nonprivate A requests, cannot read department B or C requests or private A requests, and cannot silently change another employee's title/note/privacy/state. Finance/operation job roles alone grant no access.
5. A title of whitespace fails with an accessible field error; no request is created. Optional empty note is accepted.
6. Archive changes an owned open request to archived and advances the version while preserving claims and prior evidence. Later updates fail, and archived rows remain available through authorized archive filters.
7. Search/filter/export operate within the current authorized scope. A manager's CSV excludes private or unrelated department records, even if search matches them. Spreadsheet-like strings are escaped for spreadsheet consumption.
8. CSV preview creates no equipment requests and identifies invalid/duplicate rows without referring to hidden records. Employee explicitly corrects/excludes rows and saves a new preview version before committing. Commit returns each row's created/invalid/duplicate/excluded outcome; accepted rows are owned by the employee in their current department. A stale preview version conflicts; a second commit cannot recreate its accepted rows.
9. Browser and MCP reach the same service validation/locking/disclosure: a denied update or stale version stays denied/conflicted in either transport. Token/password/membership revocation affects subsequent calls; active browser sessions likewise do not preserve obsolete membership scope.

`equipment/tests.py` expresses 13 draft expectations as Django TestCase methods, including the eight required outcomes. These tests are supplied, not executed. Browser–MCP equivalence is also directly reviewable in the two adapters' calls to service functions; a transport handshake/integration test is not supplied.
