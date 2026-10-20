# Resource booking

Prevent overlapping reservations by checking capacity, time intervals and price from the same authoritative booking decision.

This is a recipe outline; use the owning model, value and operation syntax from the handbook. Model a resource, a reservation interval, requester, status and a price snapshot. Treat start/end as timezone-aware instants or explicitly modeled local calendar values; do not compare display strings or assume every day has the same duration.

The reservation operation validates a positive interval, current resource capacity and the caller's eligibility. In one owner transaction, it checks for conflicting active reservations and commits the new reservation or returns a conflict. A separate availability display is advisory: another caller can book after it loads. The write-time check decides.

Calculate the amount with exact money values and store the currency and agreed price snapshot on the booking. A changed catalog price should not silently rewrite an existing confirmed reservation. If capacity is greater than one, count overlapping active reservations against the actual capacity rather than rejecting every overlap.

On a version conflict, reload availability and let the caller choose again. A timeout after commit must be reconciled by the reservation identity before retrying, or the user may create a duplicate booking. Test adjacent intervals, overlaps, daylight-saving transitions, capacity boundaries, concurrent requests and exact currency handling. See [dates and timezones](../03-Data/05-dates-and-timezones.md), [money](../03-Data/04-money-and-currency.md) and [transactions](../05-Workflows/03-transactions-and-concurrency.md).
