//! Package-local ECMAScript numeric text. Only the number token is replaced.
//! Historical copied-source leaf proof pinned ryu-js =1.0.3, default features off.
//! The package now registers this candidate; native-conformance.json records
//! actual assembly checks. Production joins and delivery notices remain open.
pub fn string(n: f64) -> String {
    if n == 0.0 {
        return "0".to_owned();
    }
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n == f64::INFINITY {
        return "Infinity".to_owned();
    }
    if n == f64::NEG_INFINITY {
        return "-Infinity".to_owned();
    }
    ryu_js::Buffer::new().format_finite(n).to_owned()
}
#[allow(dead_code)] // Recovery has only the String channel.
pub fn json_token(n: f64) -> String {
    if n.is_finite() {
        string(n)
    } else {
        "null".to_owned()
    }
}
