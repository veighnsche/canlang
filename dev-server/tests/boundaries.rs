//! Public-owner integration across real files, private control sockets and process groups.
#[path = "integration/capture.rs"]
mod capture;
#[path = "integration/claim.rs"]
mod claim;
#[path = "integration/compiler.rs"]
mod compiler;
#[path = "integration/control.rs"]
mod control;
#[path = "integration/files.rs"]
mod files;
#[path = "integration/fixtures.rs"]
mod fixtures;
#[path = "integration/runtime.rs"]
mod runtime;

#[path = "integration/cli.rs"]
mod cli;
#[path = "integration/construct.rs"]
mod construct;
#[path = "integration/inventory.rs"]
mod inventory;
#[path = "integration/refusals.rs"]
mod refusals;
#[path = "integration/watch.rs"]
mod watch;
