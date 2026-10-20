# Calculate dates, timezones and calendar recurrence

Separate calendar dates from instants and elapsed durations. Resolve local times explicitly, handle daylight-saving transitions, and calculate monthly occurrences from the original calendar anchor.

## Choose a date, instant or duration

| Value | Meaning and example |
| --- | --- |
| `date` | A calendar fact without a time or zone: `date("2024-01-31")` |
| `datetime` | An instant on the UTC timeline: `datetime("2024-01-31T09:00:00Z")` |
| `duration` | Elapsed integer milliseconds: `30m`, `2h`, `1d` |
| `timezone` | An IANA zone such as `"Europe/Brussels"` in an expected timezone position |

Use a date for an expense's civil receipt date or due date, and a datetime for a recorded submission instant. `1d` is exactly 24 elapsed hours, not “the same local time tomorrow”. Do not store a local wall-clock string alone when records must be ordered as actual instants.

`date` accepts checked `YYYY-MM-DD` text. `datetime` accepts a checked RFC3339 instant with millisecond precision; nonzero sub-millisecond fractions fail rather than being silently truncated. Dates use the proleptic Gregorian calendar from year 0001 through 9999. Overflow and invalid input fail.

## Calculate calendar dates and bounded ranges

These are expression examples, not standalone source files:

| Expression | Result |
| --- | --- |
| `add_days(date("2024-02-28"),1)` | 2024-02-29 |
| `date_year(date("2024-02-29"))` | `2024` |
| `weekday(date("2024-01-01"))` | `1` (Monday) |
| `dates(date("2024-02-28"),date("2024-03-02"),4)` | February 28, February 29 and March 1 |

`dates` uses a half-open interval: include `from`, exclude `until`. Its positive limit bounds work; it does not truncate a longer range. Reversed bounds, nonpositive limits or excess work fail. Equal endpoints yield an empty array. For an inclusive final date, explicitly pass `add_days(last_date,1)` after accounting for date bounds.

`overlaps(start,end,other_start,other_end)` also uses nonempty half-open intervals. Adjacent ranges ending and starting at the same boundary do not overlap. Use four dates or four datetimes, not a mixed comparison.

## Resolve local calendar intent

```can
local_instant(date("2024-01-31"),"09:00:00","Europe/Brussels",fold=earlier)
```

This expression resolves to `2024-01-31T08:00:00Z`. The `fold` argument explicitly chooses the earlier instant if the wall time occurs twice. The zone is part of the business input; it is not inferred from a user's locale or browser.

Convert an instant back to a civil date in a particular zone:

```can
local_date(datetime("2024-01-31T23:30:00Z"),"Europe/Brussels")
```

The result is February 1, 2024. This does not change the instant itself. Keep the entered zone and civil intent when users need to edit local appointments later.

## Handle daylight-saving gaps and folds

For Europe's 2024 transitions in `Europe/Brussels`:

| Local input | Result |
| --- | --- |
| March 31, `02:30:00` | Nonexistent local time; resolution fails |
| October 27, `02:30:00`, `fold=earlier` | `2024-10-27T00:30:00Z` |
| October 27, `02:30:00`, `fold=later` | `2024-10-27T01:30:00Z` |

A fold choice resolves ambiguity; it does not repair a nonexistent spring time. The app must choose how to report or reschedule a gap rather than silently inventing an instant. Zone data and calendar semantics are pinned by the language version.

For a daily local appointment, compute the next civil date and resolve it in the same zone. March 30 at 09:00 and March 31 at 09:00 in Brussels are 23 elapsed hours apart. Adding `1d` to the first instant instead lands at 10:00 local time on March 31. Use elapsed durations only when that elapsed interval is the intended rule.

## Calculate monthly recurrence from its original anchor

`add_months` clamps the original day to the destination month's last valid day. Keep the original anchor and compute each occurrence using an absolute cycle offset:

| Calculation | Result |
| --- | --- |
| `add_months(date("2024-01-31"),0)` | January 31 |
| `add_months(date("2024-01-31"),1)` | February 29 |
| `add_months(date("2024-01-31"),2)` | March 31 |
| Add one month to the already-clamped February 29 | March 29, which drifts from the original intent |

This complete app calculates three monthly review instants. Save it as `CalendarCalculations.can` and run `can check CalendarCalculations.can`:

```can
app CalendarCalculations
Given
 derive review_date(anchor:date,cycle:int):date = add_months(anchor,cycle)
 derive review_at(anchor:date,cycle:int,zone:timezone):datetime = local_instant(review_date(anchor,cycle),"09:00:00",zone,fold=earlier)
When
Then
 page / title="Calendar calculations"
  text review_date(date("2024-01-31"),0)
  text review_date(date("2024-01-31"),1)
  text review_date(date("2024-01-31"),2)
```

`cycle=0` is the anchor, `1` the next month, and `2` the month after that. A negative offset refers to a prior month; restrict inputs in the consuming operation if only future occurrences are allowed. The helper does not infer a maximum horizon, working-day adjustment or end-of-month policy beyond the declared clamping rule.

Calling `review_at(date("2024-01-31"),2,"Europe/Brussels")` resolves March 31 at 09:00 local time to `2024-03-31T07:00:00Z`. This separates two decisions: which calendar date belongs to the cycle, and which instant represents its local time.

## Schedule the computed instant deliberately

The app above calculates values; it does not enqueue events. Use its computed instant as the explicit `at` input to an authored schedule in a [scheduling workflow](../06-Business-workflows/07-scheduling-and-recurring-work.md). Keep the original anchor, zone, cycle and stable schedule identity with the owning business record when the workflow needs them.

`every(duration)` ticks align to UTC epoch periods and coalesce missed intervals; they are not a monthly calendar rule. A monthly process must define missed-cycle recovery, month-end policy, daylight-saving behavior, cancellation and any renewal consent. Business changes and schedule replacement commit together, and due handlers recheck their current guards. Do not infer automatic billing or a general recurrence language from a date helper.

See [types and builtins](../13-Language-reference/02-types-and-builtins.md) for exact signatures and [transactions](../06-Business-workflows/03-transactions-and-concurrency.md) for atomic changes.
