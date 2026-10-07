//! Finite framing contract, independently authored byte fixtures and allocation
//! observations. The allocator records requested storage only on this test's
//! thread; it does not measure RSS, allocator overhead, or caller-owned buffers.

use canlang_compiler::lsp::transport::{
    MAX_HEADER_BYTES, MAX_MESSAGE_BYTES, read_message, write_message,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io::{self, BufRead, BufReader, Cursor, Read, Write};

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static LARGEST: Cell<usize> = const { Cell::new(0) };
    static REQUESTS: Cell<usize> = const { Cell::new(0) };
    static FAIL_AT: Cell<usize> = const { Cell::new(0) };
}

struct ObservedAllocator;

fn refused(size: usize) -> bool {
    FAIL_AT
        .try_with(|threshold| threshold.get() != 0 && size >= threshold.get())
        .unwrap_or(false)
}

fn record(size: usize) {
    if TRACK.try_with(Cell::get).unwrap_or(false) {
        let _ = LARGEST.try_with(|largest| largest.set(largest.get().max(size)));
        let _ = REQUESTS.try_with(|requests| requests.set(requests.get() + 1));
    }
}

unsafe impl GlobalAlloc for ObservedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        if refused(layout.size()) {
            return std::ptr::null_mut();
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        if refused(layout.size()) {
            return std::ptr::null_mut();
        }
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        if refused(size) {
            return std::ptr::null_mut();
        }
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: ObservedAllocator = ObservedAllocator;

fn observed_read(reader: &mut impl BufRead) -> (io::Result<Option<Vec<u8>>>, usize) {
    LARGEST.set(0);
    REQUESTS.set(0);
    TRACK.set(true);
    let result = read_message(reader);
    TRACK.set(false);
    (result, LARGEST.get())
}

fn error(wire: &[u8], expected: io::ErrorKind) {
    assert_eq!(
        read_message(&mut Cursor::new(wire)).unwrap_err().kind(),
        expected
    );
}

fn padded_header(total: usize) -> Vec<u8> {
    let mut wire = b"Content-Length: 2\r\nX-Extension: ".to_vec();
    wire.resize(total - 4, b'x');
    wire.extend_from_slice(b"\r\n\r\n");
    assert_eq!(wire.len(), total);
    wire
}

#[test]
fn aggregate_header_budget_includes_the_separator_and_accepts_the_boundary() {
    // Freeze released support numbers; a numeric policy edit must revisit this witness.
    assert_eq!(MAX_HEADER_BYTES, 65_536);
    assert_eq!(MAX_MESSAGE_BYTES, 67_108_864);
    for total in [65_535, 65_536] {
        let mut wire = padded_header(total);
        wire.extend_from_slice(b"{}Content-Length: 0\r\n\r\n");
        let mut reader = Cursor::new(wire);
        assert_eq!(read_message(&mut reader).unwrap(), Some(b"{}".to_vec()));
        assert_eq!(read_message(&mut reader).unwrap(), Some(Vec::new()));
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }
    let wire = padded_header(65_537);
    let mut reader = Cursor::new(wire);
    let (result, largest) = observed_read(&mut reader);
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    assert_eq!(reader.position(), 65_536); // No excess byte retained or consumed.
    assert!(
        largest <= 65_536,
        "largest header allocation request: {largest}"
    );
}

#[test]
fn unterminated_lines_and_many_short_headers_have_the_same_finite_budget() {
    let mut line = Cursor::new(vec![b'x'; 65_537]);
    let (result, largest) = observed_read(&mut line);
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    assert_eq!(line.position(), 65_536);
    assert!(largest <= 65_536);
    let mut wire = b"Content-Length: 0\r\n".to_vec();
    wire.extend(b"X: 0\r\n".repeat(11_000));
    wire.extend_from_slice(b"\r\n");
    let mut reader = Cursor::new(wire);
    error(reader.get_ref(), io::ErrorKind::InvalidData);
    let (result, largest) = observed_read(&mut reader);
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    assert_eq!(reader.position(), 65_536);
    assert!(largest <= 65_536);
}

#[test]
fn one_byte_header_reads_do_not_allocate_for_every_byte() {
    let mut wire = padded_header(65_536);
    wire.extend_from_slice(b"{}");
    let mut reader = BufReader::with_capacity(1, Cursor::new(wire));
    let (result, largest) = observed_read(&mut reader);
    assert_eq!(result.unwrap(), Some(b"{}".to_vec()));
    assert!(largest <= 65_536);
    assert!(
        REQUESTS.get() < 32,
        "one-byte header storage requests: {}",
        REQUESTS.get()
    );
}

#[test]
fn declared_body_at_the_existing_cap_does_not_allocate_before_payload() {
    // A small fixture observes timing without requesting a giant allocation.
    let header = b"Content-Length: 67108864\r\n\r\n";
    let (result, largest) = observed_read(&mut Cursor::new(header));
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    // The small io::Error object also allocates; no body growth block is requested.
    assert!(largest < 8192, "premature body allocation: {largest}");
    let mut prefix = header.to_vec();
    prefix.push(b'x');
    let (result, largest) = observed_read(&mut Cursor::new(prefix));
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    assert!(largest <= 16_384, "one-byte payload allocation: {largest}");
    error(
        b"Content-Length: 67108865\r\n\r\n",
        io::ErrorKind::InvalidData,
    );
}

#[test]
fn arrived_body_storage_grows_proportionally_and_stops_at_the_declared_boundary() {
    let mut wire = b"Content-Length: 1000000\r\n\r\n".to_vec();
    wire.extend(std::iter::repeat_n(b'x', 65_537));
    let (result, largest) = observed_read(&mut Cursor::new(wire));
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
    assert!(largest <= 131_072, "prefix allocation: {largest}");
    let mut wire = b"Content-Length: 65537\r\n\r\n".to_vec();
    wire.extend(std::iter::repeat_n(b'x', 65_537));
    wire.extend_from_slice(b"Content-Length: 2\r\n\r\n[]");
    let mut reader = Cursor::new(wire);
    let (result, largest) = observed_read(&mut reader);
    let body = result.unwrap().unwrap();
    assert_eq!(body.len(), 65_537);
    assert!(body.iter().all(|byte| *byte == b'x'));
    assert!(
        largest <= 65_537,
        "body allocation exceeds declaration: {largest}"
    );
    assert_eq!(read_message(&mut reader).unwrap(), Some(b"[]".to_vec()));
}

#[test]
fn duplicates_are_accepted_only_when_all_declared_byte_counts_agree() {
    for wire in [
        b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
        b"content-length: 02\nCONTENT-LENGTH:\t2 \nX-Trace: ok\n\n{}".as_slice(),
    ] {
        assert_eq!(
            read_message(&mut Cursor::new(wire)).unwrap(),
            Some(b"{}".to_vec())
        );
    }
    for wire in [
        b"Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}".as_slice(),
        b"Content-Length: 3\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
        b"Content-Length: 2\r\nContent-Length: invalid\r\n\r\n{}".as_slice(),
        b"Content-Length: 67108865\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
    ] {
        error(wire, io::ErrorKind::InvalidData);
    }
}

struct Partial<'a>(&'a [u8]);

impl Read for Partial<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = self.0.len().min(output.len()).min(3);
        output[..count].copy_from_slice(&self.0[..count]);
        self.0 = &self.0[count..];
        Ok(count)
    }
}

#[test]
fn legal_extension_headers_unicode_and_partial_reads_keep_exact_boundaries() {
    let wire = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nX-Trace: extension\r\nContent-Length: 9\r\n\r\n\"\xc3\xa9\xf0\x9f\x98\x80\"!Content-Length: 2\n\n[]";
    let mut reader = BufReader::with_capacity(5, Partial(wire));
    assert_eq!(
        read_message(&mut reader).unwrap(),
        Some(b"\"\xc3\xa9\xf0\x9f\x98\x80\"!".to_vec())
    );
    assert_eq!(read_message(&mut reader).unwrap(), Some(b"[]".to_vec()));
    assert_eq!(read_message(&mut reader).unwrap(), None);
}

#[test]
fn clean_eof_and_torn_headers_and_bodies_remain_distinct() {
    assert_eq!(read_message(&mut Cursor::new(b"")).unwrap(), None);
    for wire in [
        b"Content-Length: 2".as_slice(),
        b"Content-Length: 2\r\n".as_slice(),
        b"Content-Length: 2\r\n\r\nx".as_slice(),
    ] {
        error(wire, io::ErrorKind::UnexpectedEof);
    }
    error(b"X-Only: extension\r\n\r\n", io::ErrorKind::InvalidData);
}

struct PartialWriter(Vec<u8>);

impl Write for PartialWriter {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        let count = input.len().min(2);
        self.0.extend_from_slice(&input[..count]);
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn partial_writes_emit_an_independently_expected_utf8_byte_count() {
    let mut writer = PartialWriter(Vec::new());
    write_message(&mut writer, "\"é😀\"".as_bytes()).unwrap();
    assert_eq!(
        writer.0,
        b"Content-Length: 8\r\n\r\n\"\xc3\xa9\xf0\x9f\x98\x80\""
    );
}

#[test]
fn refused_header_and_arrived_body_allocations_return_io_errors() {
    // Deliberately refuse only these small fallible Vec requests, without
    // exhausting the allocator or blocking allocation of the error itself.
    let header = padded_header(2048);
    let mut body = b"Content-Length: 20000\r\n\r\n".to_vec();
    body.extend(std::iter::repeat_n(b'x', 20_000));
    for (wire, threshold) in [(header, 1024), (body, 8192)] {
        let mut reader = Cursor::new(wire);
        FAIL_AT.set(threshold);
        let (result, _) = observed_read(&mut reader);
        FAIL_AT.set(0);
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::OutOfMemory);
    }
}

struct InterruptedReader<'a> {
    inner: Partial<'a>,
    interrupt: bool,
}

impl Read for InterruptedReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.interrupt = !self.interrupt;
        if self.interrupt {
            Err(io::Error::from(io::ErrorKind::Interrupted))
        } else {
            self.inner.read(output)
        }
    }
}

#[test]
fn transient_interruptions_retry_header_and_body_acquisition() {
    let mut reader = BufReader::with_capacity(
        4,
        InterruptedReader {
            inner: Partial(b"Content-Length: 2\r\n\r\n{}"),
            interrupt: false,
        },
    );
    assert_eq!(read_message(&mut reader).unwrap(), Some(b"{}".to_vec()));
    assert_eq!(read_message(&mut reader).unwrap(), None);
}
