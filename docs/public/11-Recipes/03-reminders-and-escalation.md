# Reminders and escalation

Schedule reminders against a specific record revision so changed or completed work cannot trigger stale escalation.

Model the due date, current status, owner and escalation policy on the business record. When the responsible operation accepts a state change, schedule a reminder that carries the record identity and expected revision. The handler reloads current state and rechecks due time, status, owner and revision before sending.

If the record was completed, reassigned or rescheduled, the old reminder becomes ineligible and exits without sending. A new accepted state can schedule a new reminder; cancellation is useful cleanup, but the handler must still validate current state because cancellation can race with dispatch.

Persist delivery intent separately from the business transition. If the provider times out, reconcile its delivery receipt before retrying. Escalation should record who was notified and why, while avoiding disclosure to a former owner after reassignment.

Test completion before dispatch, reassignment, rescheduling, duplicate dispatch, late delivery and uncertain provider acceptance. See [scheduling](../05-Workflows/06-scheduling-and-recurring-work.md), [deliveries](../07-Integrations/02-deliveries-and-recovery.md) and [operation permissions](../04-Access-and-rules/02-roles-and-operation-permissions.md).
