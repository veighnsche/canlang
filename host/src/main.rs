//! Arm parent death before exec, preserving the already locked open description.
use std::env;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{self, Command};

unsafe extern "C" {
    fn prctl(option: i32, ...) -> i32;
    fn getppid() -> i32;
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}

fn run() -> io::Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() < 6 || args[4] != "--" {
        return Err(io::Error::other("expected PARENT_PID LOCK_FD CONTROL_FD WORKERD -- ARGS"));
    }
    let number = |index: usize| -> io::Result<i32> {
        args[index].to_str().and_then(|value| value.parse().ok()).filter(|value| *value > 0)
            .ok_or_else(|| io::Error::other("invalid guard descriptor or parent"))
    };
    let parent = number(0)?;
    let lock = number(1)?;
    let control = number(2)?;
    if lock < 3 || control < 3 || lock == control || !Path::new(&args[3]).is_absolute() {
        return Err(io::Error::other("invalid workerd executable or inherited descriptors"));
    }
    // The comparison closes the race in which Node died before prctl was armed.
    if unsafe { prctl(1, 9, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { getppid() } != parent {
        return Err(io::Error::other("workerd parent retired before guard admission"));
    }
    for fd in [lock, control] {
        let flags = unsafe { fcntl(fd, 1) }; // F_GETFD
        if flags < 0 || unsafe { fcntl(fd, 2, flags & !1) } < 0 { // F_SETFD, !FD_CLOEXEC
            return Err(io::Error::last_os_error());
        }
    }
    Err(Command::new(&args[3]).args(&args[5..]).exec())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("can-workerd-exec: {error}");
        process::exit(1);
    }
}
