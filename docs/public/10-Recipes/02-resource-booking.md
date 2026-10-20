# Reserve a resource without overlapping bookings

Reserve a single-capacity resource with authoritative interval checks, snapshot its exact price, cancel through the owning caller and verify adjacent bookings, overlaps and concurrent requests.

## Source and prerequisites

Download [Bookings.can](../examples/recipes/Bookings.can), a complete app for one booking at a time per resource. Install Can, check the file, then start:

```sh
can check Bookings.can
can dev ui --source Bookings.can --preview-roles '{"Ava":["manager"],"Ben":[]}'
```

Ava manages resources; members reserve them. This team app deliberately exposes booking account and interval information to all members. Change that policy if your calendar requires private reservations. It does not collect payment: `price` is an agreed flat price per reservation, not an hourly calculation.

## Create and reserve a room

As Ava, create resource “Demo room”, with price EUR 25.00 and `active=true`. As Ben, select it in the reservation form and enter two future instants, for example 09:00–10:00 UTC on a chosen future date. Use actual datetimes accepted by the form; do not paste expired tutorial dates.

The complete source owns this write-time decision:

```can
scenario reserve(resource:Resource,starts:datetime,ends:datetime) by=members -> Booking
 require resource.active and starts>=now and starts<ends
 require not any(Booking as booking,booking.resource==resource and not booking.cancelled and overlaps(starts,ends,booking.starts,booking.ends))
 do
  create Booking {resource,starts,ends,price=resource.price} as booking
  return booking
```

The overlapping query and create belong to the same owning transaction. A prior availability screen is advisory. The new booking retains its resource, interval, requester and exact money price under locks. Later catalog price edits do not rewrite it.

## Cancel and verify boundaries

Use **Cancel booking** as the requester. Cancellation sets the flag once; the historical interval and price remain. An active overlap can then be reserved again.

Verify these cases with two member sessions:

| Case | Expected result |
| --- | --- |
| 09:00–10:00 followed by 10:00–11:00 | Adjacent intervals can coexist. |
| 09:30–10:30 against the active first booking | Refused. |
| End at or before start, or start in the past | Refused. |
| Another member cancels Ben's booking | Refused. |
| Manager changes room price | Existing booking retains EUR 25.00. |
| Concurrent requests for the same free interval | No two overlapping active reservations commit. |

On a concurrency refusal, reread the calendar and choose again. If transport lost a response, recover/replay the original operation identity before creating a new logical reservation. The [transaction contract](../06-Business-workflows/03-transactions-and-concurrency.md) governs retries.

## Adapt capacity and local-time rules explicitly

This source models capacity **one**. For capacity greater than one, replace the rule with an authoritative overlapping-count/capacity decision; do not simply remove it. For local calendar input, resolve the intended zone and daylight-saving gap/fold policy to instants before reserving. Follow [dates and timezones](../04-Model-and-query-data/05-dates-and-timezones.md). Exact money calculations and currency rules belong in [money](../04-Model-and-query-data/04-money-and-currency.md) if the flat-price policy is replaced.
