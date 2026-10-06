//! UTC instant algorithms (`temporal.ts` datetime builtins).
//!
//! The permissive public `datetime(text)` parser (any precision fraction,
//! explicit offset) is separate from the pinned wire grammar, which lives
//! with the codecs. Instants are integer milliseconds in 0001-9999.

use num_bigint::BigInt;

use crate::failures::Failure;
use crate::representations::numeric::{
    assert_datetime_in_range, is_datetime_value, make_datetime, require_datetime, DatetimeParts,
    Value,
};
use crate::temporal::civil::days_from_civil;

const MS_PER_DAY: i64 = 86_400_000;

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

struct DatetimeFields {
    year: i32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    fraction: Option<String>,
    offset: Option<(bool, u8, u8)>,
}

/// Matches the public constructor grammar:
/// `YYYY-MM-DD[Tt]HH:MM:SS[.fraction]([Zz]|[+-]HH:MM)` with ASCII digits.
fn match_datetime_text(text: &str) -> Option<DatetimeFields> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let digits = |from: usize, to: usize| -> Option<i32> {
        let part = text.get(from..to)?;
        if part.len() == to - from && part.bytes().all(|b| b.is_ascii_digit()) {
            part.parse::<i32>().ok()
        } else {
            None
        }
    };
    let year = digits(0, 4)?;
    if bytes[4] != b'-' {
        return None;
    }
    let month = digits(5, 7)?;
    if bytes[7] != b'-' {
        return None;
    }
    let day = digits(8, 10)?;
    if bytes[10] != b'T' && bytes[10] != b't' {
        return None;
    }
    let hour = digits(11, 13)?;
    if bytes[13] != b':' {
        return None;
    }
    let minute = digits(14, 16)?;
    if bytes[16] != b':' {
        return None;
    }
    let second = digits(17, 19)?;
    let mut rest = &text[19..];
    let mut fraction = None;
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digit_len = after_dot.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digit_len == 0 {
            return None;
        }
        fraction = Some(after_dot[..digit_len].to_string());
        rest = &after_dot[digit_len..];
    }
    let offset = if rest == "Z" || rest == "z" {
        None
    } else if rest.len() == 6
        && (rest.as_bytes()[0] == b'+' || rest.as_bytes()[0] == b'-')
        && rest.as_bytes()[3] == b':'
    {
        let sign_positive = rest.as_bytes()[0] == b'+';
        if !rest[1..3].bytes().all(|b| b.is_ascii_digit())
            || !rest[4..6].bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let oh = rest[1..3].parse::<i32>().ok()?;
        let om = rest[4..6].parse::<i32>().ok()?;
        Some((sign_positive, oh as u8, om as u8))
    } else {
        return None;
    };
    Some(DatetimeFields {
        year,
        month: month as u8,
        day: day as u8,
        hour: hour as u8,
        minute: minute as u8,
        second: second as u8,
        fraction,
        offset,
    })
}

/// Checked `datetime(text)` constructor: explicit numeric or Zulu offset
/// (offset colon required); nonzero sub-millisecond digits are rejected
/// rather than truncated; leap second 60 is rejected.
pub fn parse_datetime(value: &Value) -> Result<DatetimeParts, Failure> {
    let text = match value {
        Value::Str(text) => text,
        _ => return Err(Failure::invalid_construction("datetime() requires text")),
    };
    let Some(fields) = match_datetime_text(text) else {
        return Err(Failure::invalid_construction(format!(
            "invalid datetime text: {text}"
        )));
    };
    if fields.year < 1 || fields.year > 9999 {
        return Err(Failure::out_of_range(format!(
            "datetime year outside 0001-9999: {text}"
        )));
    }
    if fields.month < 1
        || fields.month > 12
        || fields.day < 1
        || fields.day > days_in_month(fields.year, fields.month)
    {
        return Err(Failure::invalid_construction(format!(
            "invalid calendar date: {text}"
        )));
    }
    if fields.hour > 23 || fields.minute > 59 || fields.second > 59 {
        return Err(Failure::invalid_construction(format!(
            "invalid time of day: {text}"
        )));
    }
    if let Some((_, off_hour, off_minute)) = fields.offset {
        if off_hour > 23 || off_minute > 59 {
            return Err(Failure::invalid_construction(format!(
                "invalid zone offset: {text}"
            )));
        }
    }
    let mut ms: i64 = 0;
    if let Some(fraction) = fields.fraction {
        let mut milli_digits = fraction.chars().take(3).collect::<String>();
        while milli_digits.len() < 3 {
            milli_digits.push('0');
        }
        ms = milli_digits.parse::<i64>().expect("digit-only millis");
        let sub_ms: String = fraction.chars().skip(3).collect();
        if !sub_ms.bytes().all(|b| b == b'0') {
            return Err(Failure::invalid_construction(format!(
                "nonzero sub-millisecond fraction rejected: {text}"
            )));
        }
    }
    let days = days_from_civil(fields.year, fields.month, fields.day);
    let mut instant = BigInt::from(days) * BigInt::from(MS_PER_DAY)
        + BigInt::from(
            fields.hour as i64 * 3_600_000
                + fields.minute as i64 * 60_000
                + fields.second as i64 * 1000
                + ms,
        );
    if let Some((positive, off_hour, off_minute)) = fields.offset {
        let offset_ms = BigInt::from((off_hour as i64 * 60 + off_minute as i64) * 60_000);
        instant = if positive {
            instant - offset_ms
        } else {
            instant + offset_ms
        };
    }
    assert_datetime_in_range(&instant)?;
    make_datetime(instant)
}

/// `durationBetween(a, b)`: datetime minus datetime, int64-checked.
pub fn duration_between(a: &Value, b: &Value) -> Result<i64, Failure> {
    let left = require_datetime(a, "durationBetween")?;
    let right = require_datetime(b, "durationBetween")?;
    crate::representations::numeric::check_int64_temporal(
        &(left.ms - right.ms),
        "datetime subtraction",
    )
}

/// `compareInstant(a, b)`: -1/0/1 by UTC instant.
pub fn compare_instant(a: &Value, b: &Value) -> Result<i8, Failure> {
    let left = require_datetime(a, "compareInstant")?;
    let right = require_datetime(b, "compareInstant")?;
    Ok(if left.ms < right.ms {
        -1
    } else if left.ms > right.ms {
        1
    } else {
        0
    })
}

/// Half-open datetime-range overlap used by the `overlaps` dispatcher.
pub fn overlaps_datetimes(
    a_start: &BigInt,
    a_end: &BigInt,
    b_start: &BigInt,
    b_end: &BigInt,
) -> bool {
    if a_start >= a_end || b_start >= b_end {
        return false;
    }
    let latest_start = if a_start >= b_start { a_start } else { b_start };
    let earliest_end = if a_end <= b_end { a_end } else { b_end };
    latest_start < earliest_end
}

/// `overlaps(aStart, aEnd, bStart, bEnd)`: four dates or four datetimes;
/// empty/reversed ranges are false; mixed inputs fail.
pub fn overlaps(
    a_start: &Value,
    a_end: &Value,
    b_start: &Value,
    b_end: &Value,
) -> Result<bool, Failure> {
    use crate::representations::numeric::{is_date_value, require_date};
    let args = [a_start, a_end, b_start, b_end];
    if args.iter().copied().all(is_date_value) {
        let dates: Vec<_> = args
            .iter()
            .copied()
            .map(|v| require_date(v, "overlaps"))
            .collect::<Result<_, _>>()?;
        return Ok(crate::temporal::civil::overlaps_dates(
            &dates[0], &dates[1], &dates[2], &dates[3],
        ));
    }
    if args.iter().copied().all(is_datetime_value) {
        let datetimes: Vec<_> = args
            .iter()
            .copied()
            .map(|v| require_datetime(v, "overlaps"))
            .collect::<Result<_, _>>()?;
        return Ok(overlaps_datetimes(
            &datetimes[0].ms,
            &datetimes[1].ms,
            &datetimes[2].ms,
            &datetimes[3].ms,
        ));
    }
    Err(Failure::invalid_construction(
        "overlaps requires four dates or four datetimes",
    ))
}
