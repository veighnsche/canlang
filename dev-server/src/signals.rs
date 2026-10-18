use std::sync::atomic::{AtomicBool, Ordering};
static INTERRUPTED: AtomicBool = AtomicBool::new(false);
extern "C" fn interrupt(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Release);
}
pub fn install() {
    unsafe {
        libc::signal(libc::SIGINT, interrupt as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, interrupt as *const () as libc::sighandler_t);
        libc::signal(libc::SIGHUP, interrupt as *const () as libc::sighandler_t);
    }
}
pub fn take() -> bool {
    INTERRUPTED.swap(false, Ordering::AcqRel)
}
