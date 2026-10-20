# Dates, instants, and time zones

Use a civil `date` for calendar facts such as a birthday or due date. Use `datetime` for an instant on the UTC timeline, and `duration` for elapsed time. Do not store a local wall-clock string when the system must order or compare actual instants.

A local appointment combines a civil date/time and a named time zone, then resolves to an instant with an explicit daylight-saving policy. Some local times do not exist during a spring transition; others occur twice during an autumn transition. Require a defined choice rather than guessing. Calendar month arithmetic is anchored to the original date and follows explicit month-end rules; repeated addition of a month can otherwise drift.

Keep the entered zone and civil intent when users need to see or edit local appointments. Use the time builtins in [types and builtins](../12-Reference/07-types-and-builtins.md). Recurring schedule policy is authored business behavior, covered in [scheduling](../05-Workflows/06-scheduling-and-recurring-work.md).
