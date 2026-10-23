//! A real terminal drives the shipping attached UI against a live native owner.
use std::{
    fs::File,
    io::{Read, Write},
    os::{fd::FromRawFd, unix::process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
fn screen_text(text: &str) -> String {
    let mut output = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.next() == Some('[') {
                for ch in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&ch) {
                        break;
                    }
                }
            }
        } else if !c.is_whitespace() {
            output.push(c);
        }
    }
    output
}
struct Terminal {
    master: File,
    child: Child,
    text: String,
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Terminal {
    fn read(&mut self) {
        let mut buffer = [0; 8192];
        loop {
            match self.master.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]);
                    if text.contains("\x1b[6n") {
                        self.master.write_all(b"\x1b[1;1R").unwrap();
                    }
                    self.text.push_str(&text);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                Err(e) => panic!("PTY read: {e}"),
            }
        }
    }
    fn until(&mut self, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            self.read();
            if screen_text(&self.text).contains(&needle.split_whitespace().collect::<String>()) {
                return;
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!("UI exited {status} before {needle}: {}", self.text);
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("UI missing {needle}: {}", self.text);
    }
}
pub fn attached(root: &Path, temporary: &Path, session: &str) {
    let mut master = -1;
    let mut slave = -1;
    let size = libc::winsize {
        ws_row: 24,
        ws_col: 80,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                &size,
            )
        },
        0
    );
    let master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    use std::os::fd::AsRawFd;
    assert_ne!(
        unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) },
        -1
    );
    let mut command = Command::new(env!("CARGO_BIN_EXE_can-dev"));
    command
        .args(["ui", "--root"])
        .arg(root)
        .args(["--session", session])
        .env("TMPDIR", temporary)
        .env("TERM", "xterm-256color")
        .env("NO_COLOR", "1")
        .stdin(Stdio::from(slave.try_clone().unwrap()))
        .stdout(Stdio::from(slave.try_clone().unwrap()))
        .stderr(Stdio::from(slave.try_clone().unwrap()));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().unwrap();
    drop(slave);
    let mut terminal = Terminal {
        master,
        child,
        text: String::new(),
    };
    terminal.until("attached");
    terminal.master.write_all(b"stop\r").unwrap();
    terminal.until("Attached view cannot stop");
    // Resize an active inline UI; commands still pass through the real editor.
    let narrow = libc::winsize {
        ws_row: 24,
        ws_col: 44,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    assert_eq!(
        unsafe { libc::ioctl(terminal.master.as_raw_fd(), libc::TIOCSWINSZ, &narrow) },
        0
    );
    terminal.master.write_all(b"statuX\x7fs\rhelp\r").unwrap();
    thread::sleep(Duration::from_millis(150));
    terminal.read();
    terminal.master.write_all(b"detach\r").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        terminal.read();
        if let Some(status) = terminal.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "UI did not detach: {}",
            terminal.text
        );
        thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{}", terminal.text);
    assert!(
        !terminal.text.contains("access?"),
        "credentials require an explicit open action"
    );
    assert!(!terminal.text.contains("\x1b[31m"));
}
