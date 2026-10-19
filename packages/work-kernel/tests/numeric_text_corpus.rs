// Numeric-text corpus integration target: the frozen N03 expectations run
// against the registered leaf module directly. `native-numeric-text.rs`
// uses `super::*`, satisfied here by the sibling leaf module below.
#[path = "../decisions/numeric_text.rs"]
mod numeric_text;

// Frozen exact-source corpus: never reformatted (byte-pinned expectations).
#[rustfmt::skip]
#[path = "native-numeric-text.rs"]
mod native_numeric_text;
