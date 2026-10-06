//! Native exact-values core for `@canlang/values` (private package API).
//!
//! Implements the exact arithmetic, temporal math, numeric aggregates and
//! scalar wire codecs of `packages/values` with behavior-preserving
//! parity: same values, stored parts, canonical wire, error classes, codes,
//! messages and precedence as the TypeScript surface. Host concerns
//! (freezing, public classes, getters/proxies, dispatch, traversal and all
//! non-scalar types) stay TypeScript-owned.
//!
//! Module ownership mirrors the implementation plan: `numeric` (integer,
//! rounding, decimal, money), `temporal` (civil, instant, duration),
//! `aggregates` (owned sums), `codecs` (scalar wire), `transport` (ABI
//! envelope), `representations` (carriers and guards), `failures`
//! (error codes), `currency_facts` (owner-generated table).

pub mod aggregates;
pub mod codecs;
pub mod currency_facts;
pub mod failures;
pub mod input;
pub mod numeric;
pub mod plans;
pub mod profiles;
pub mod representations;
pub mod temporal;
pub mod transport;
