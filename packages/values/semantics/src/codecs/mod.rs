pub mod numeric;

// V03.5 shared registrations: the structural error taxonomies reused by
// the binding scaffold (`profiles.rs`) without duplicating the numeric
// transport. Arena and plan modules stay the owners; this root only
// registers them for coordinators.
pub use crate::input::TransportError;
pub use crate::plans::{PlanCode, PlanError};
