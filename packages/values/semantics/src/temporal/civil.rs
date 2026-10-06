//! UTC civil-date algorithms (`temporal.ts` date builtins).
//!
//! Pure proleptic-Gregorian calendar math (Hinnant algorithms); no host
//! date math. Years 0001-9999; month-end clamping; half-open ranges.

use num_bigint::BigInt;

use crate::failures::Failure;
use crate::representations::numeric::{
    is_integer_number, make_date, require_date, require_temporal_int, DateParts, Value,
};

const EPOCH_DAYS_MIN: i64 = -719162;
const EPOCH_DAYS_MAX: i64 = 2_932_896;

/// Days from 1970-01-01 to the given civil date (`daysFromCivil`).
/// Inputs are validated date parts; all intermediates fit i64.
pub fn days_from_civil(year: i32, month: u8, day: u8) -> i64 {
    let (year, month, day) = (year as i64, month as i64, day as i64);
    let y_adj = if month <= 2 { year - 1 } else { year };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of `days_from_civil` (`civilFromDays`). Floor division matches
/// `Math.floor` for every input, including out-of-range days.
pub fn civil_from_days(z: i64) -> (i32, u8, u8) {
    let z2 = z + 719468;
    let era = z2.div_euclid(146097);
    let doe = z2 - era * 146097;
    let yoe = (doe - doe.div_euclid(1460) + doe.div_euclid(36524) - doe.div_euclid(146096)) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u8, d as u8)
}

/// Epoch days of a validated date (`dateToEpochDays`).
pub fn date_to_epoch_days(value: &Value) -> Result<i64, Failure> {
    if !crate::representations::numeric::is_date_value(value) {
        return Err(Failure::invalid_construction("expected a date value"));
    }
    let date = require_date(value, "dateToEpochDays")?;
    Ok(days_from_civil(date.year, date.month, date.day))
}

/// Civil date of epoch days (`epochDaysToDate`). Range-checked to 0001-9999.
/// Inputs beyond +/-4M days cannot fall in range (the true boundary is
/// inside +/-3M), so they fail without civil computation.
pub fn epoch_days_to_date(days: &Value) -> Result<DateParts, Failure> {
    let days_num = match days {
        Value::Num(number) if is_integer_number(*number) => *number,
        _ => {
            return Err(Failure::invalid_construction(
                "epoch days must be an integer",
            ));
        }
    };
    if days_num < -4_000_000.0 || days_num > 4_000_000.0 {
        return Err(Failure::out_of_range("civil date outside 0001-9999"));
    }
    let (year, month, day) = civil_from_days(days_num as i64);
    if !(1..=9999).contains(&year) {
        return Err(Failure::out_of_range("civil date outside 0001-9999"));
    }
    make_date(year as f64, month as f64, day as f64)
}

/// Matches `/^(\d{4})-(\d{2})-(\d{2})$/` returning (year, month, day).
fn match_date_text(text: &str) -> Option<(f64, f64, f64)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |from: usize, to: usize| -> Option<f64> {
        let part = &text[from..to];
        if part.bytes().all(|b| b.is_ascii_digit()) {
            Some(part.parse::<f64>().unwrap_or(f64::NAN))
        } else {
            None
        }
    };
    Some((digits(0, 4)?, digits(5, 7)?, digits(8, 10)?))
}

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

/// Checked `date(text)` constructor: strict YYYY-MM-DD, years 0001-9999.
pub fn parse_date(value: &Value) -> Result<DateParts, Failure> {
    let text = match value {
        Value::Str(text) => text,
        _ => return Err(Failure::invalid_construction("date() requires text")),
    };
    let Some((year, month, day)) = match_date_text(text) else {
        return Err(Failure::invalid_construction(format!(
            "invalid date text: {text}"
        )));
    };
    if year < 1.0 || year > 9999.0 {
        return Err(Failure::out_of_range(format!(
            "date year outside 0001-9999: {text}"
        )));
    }
    if month < 1.0
        || month > 12.0
        || day < 1.0
        || day > days_in_month(year as i32, month as u8) as f64
    {
        return Err(Failure::invalid_construction(format!(
            "invalid civil date: {text}"
        )));
    }
    make_date(year, month, day)
}

/// `add_days(value, days)`: calendar-day arithmetic, 0001-9999 checked.
pub fn add_days(value: &Value, days: &Value) -> Result<DateParts, Failure> {
    let start = require_date(value, "add_days value")?;
    let delta = require_temporal_int(days, "add_days days")?;
    let start_days = BigInt::from(days_from_civil(start.year, start.month, start.day));
    let target = start_days + delta;
    if target < BigInt::from(EPOCH_DAYS_MIN) || target > BigInt::from(EPOCH_DAYS_MAX) {
        return Err(Failure::out_of_range("add_days result outside 0001-9999"));
    }
    let days_i64: i64 = target
        .to_string()
        .parse()
        .expect("range-checked epoch days");
    let (year, month, day) = civil_from_days(days_i64);
    make_date(year as f64, month as f64, day as f64)
}

fn floor_div_mod(index: &BigInt) -> (i32, u8) {
    let twelve = BigInt::from(12);
    let mut year_base = index / &twelve;
    let mut month_index = index % &twelve;
    if month_index < BigInt::ZERO {
        month_index += &twelve;
        year_base -= BigInt::from(1);
    }
    let year: i64 = (year_base + BigInt::from(1))
        .to_string()
        .parse::<i64>()
        .expect("in-range year");
    let month_index: i64 = month_index
        .to_string()
        .parse::<i64>()
        .expect("month index 0..12");
    (year as i32, month_index as u8)
}

/// `add_months(value, months)`: signed Gregorian months with stateless
/// target-month clamping of the original day.
pub fn add_months(value: &Value, months: &Value) -> Result<DateParts, Failure> {
    let start = require_date(value, "add_months value")?;
    let delta = require_temporal_int(months, "add_months months")?;
    let start_index = BigInt::from((start.year - 1) * 12 + (start.month as i32 - 1));
    let target = start_index + delta;
    if target < BigInt::ZERO || target > BigInt::from(9999 * 12 - 1) {
        return Err(Failure::out_of_range("add_months result outside 0001-9999"));
    }
    let (year, month_index) = floor_div_mod(&target);
    let month = month_index + 1;
    let day = start.day.min(days_in_month(year, month));
    make_date(year as f64, month as f64, day as f64)
}

/// `date_year(value)`: Gregorian year.
pub fn date_year(value: &Value) -> Result<BigInt, Failure> {
    Ok(BigInt::from(require_date(value, "date_year value")?.year))
}

/// `weekday(value)`: ISO Monday=1 through Sunday=7.
pub fn weekday(value: &Value) -> Result<BigInt, Failure> {
    let current = require_date(value, "weekday value")?;
    let days = days_from_civil(current.year, current.month, current.day);
    Ok(BigInt::from((days + 3).rem_euclid(7) + 1))
}

/// `dates(from, until, limit)`: consecutive dates in ascending half-open
/// [from,until) order. Guards run first (both endpoints, then the limit
/// TYPE); equal endpoints then give [] without consulting the limit value.
pub fn dates(from: &Value, until: &Value, limit: &Value) -> Result<Vec<DateParts>, Failure> {
    let start = require_date(from, "dates from")?;
    let end = require_date(until, "dates until")?;
    // The limit type check precedes the count checks; only the limit VALUE
    // (positivity, range cap) is skipped for equal endpoints.
    let bound = require_temporal_int(limit, "dates limit")?;
    let from_days = days_from_civil(start.year, start.month, start.day);
    let until_days = days_from_civil(end.year, end.month, end.day);
    let count = until_days - from_days;
    if count < 0 {
        return Err(Failure::invalid_construction(
            "dates from must not be after until",
        ));
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if bound <= &BigInt::ZERO {
        return Err(Failure::invalid_construction(
            "dates limit must be positive",
        ));
    }
    if BigInt::from(count) > *bound {
        return Err(Failure::new(
            crate::failures::ValueFailureCode::LimitExceeded,
            format!("dates range of {count} exceeds limit {bound}"),
        ));
    }
    let mut out = Vec::with_capacity(count as usize);
    for index in 0..count {
        let (year, month, day) = civil_from_days(from_days + index);
        out.push(make_date(year as f64, month as f64, day as f64)?);
    }
    Ok(out)
}

/// `compareDate(a, b)`: -1/0/1 by civil date.
pub fn compare_date(a: &Value, b: &Value) -> Result<i8, Failure> {
    let left = require_date(a, "compareDate")?;
    let right = require_date(b, "compareDate")?;
    Ok(if left.year != right.year {
        if left.year < right.year {
            -1
        } else {
            1
        }
    } else if left.month != right.month {
        if left.month < right.month {
            -1
        } else {
            1
        }
    } else if left.day != right.day {
        if left.day < right.day {
            -1
        } else {
            1
        }
    } else {
        0
    })
}

/// Half-open date-range overlap used by the `overlaps` dispatcher.
pub fn overlaps_dates(
    a_start: &DateParts,
    a_end: &DateParts,
    b_start: &DateParts,
    b_end: &DateParts,
) -> bool {
    let cmp = |x: &DateParts, y: &DateParts| -> i8 {
        if x.year != y.year {
            if x.year < y.year {
                -1
            } else {
                1
            }
        } else if x.month != y.month {
            if x.month < y.month {
                -1
            } else {
                1
            }
        } else if x.day != y.day {
            if x.day < y.day {
                -1
            } else {
                1
            }
        } else {
            0
        }
    };
    if cmp(a_start, a_end) >= 0 || cmp(b_start, b_end) >= 0 {
        return false;
    }
    let latest_start = if cmp(a_start, b_start) >= 0 {
        a_start
    } else {
        b_start
    };
    let earliest_end = if cmp(a_end, b_end) <= 0 { a_end } else { b_end };
    cmp(latest_start, earliest_end) < 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_line_removed_check() {
        // civil_from_days must invert days_from_civil on spot checks.
        for (y, m, d) in [(1, 1, 1), (1970, 1, 1), (2024, 2, 29), (9999, 12, 31)] {
            let z = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(z), (y, m, d));
        }
    }
}
