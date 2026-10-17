# Expense reviewer revocation recovery

Verified inputs and full independent wording rewrites are saved in `migration-expense-recovery-{1,2,3}.questions.json`; full requests/results are adjacent `.result.json` files. No live records, provider credentials or runtime claims were sent.

Responses disagree: withdrawal .62 / reassignment .33 / restoration .05 (confidence .44); reassignment .63 / withdrawal .36 / restoration .01 (.45); reassignment .69 / withdrawal .29 / restoration .02 (.53). No voting or automatic approval threshold selected the policy.

Investigation: reassignment can retain submitted value and avoid another claim, but DESIGN §4 explicitly applies pre-state locks to scenarios. It would require changing the existing reviewer evidence lock and adding immutable assignment evidence with an authorized replacement policy. Restoration avoids new syntax but leaves deliberately permanent revocations stranded. Withdrawal plus the existing one-successor correction uses the current locks without exception, records the reason on the old claim and keeps withdrawal distinct from a reviewer decision. It creates an additional record on recovery; that cost is explicit. This source policy preserves all submitted evidence and current private claimant authority, without adding a general language primitive or pretending reassignment is already safe.

Chosen bounded rule: eligible claimant may withdraw only a submitted claim with lost reviewer role or site eligibility, with a nonempty reason; old evidence stays locked and one linked successor is admitted. Current role/eligibility must be rechecked on new submission. Approved or reimbursed claims cannot use it. Independent journey review and target/example correspondence remain required; JEV advice is not proof of execution.
