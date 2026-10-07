//! Dependency-free LSP stdio transport: Content-Length framing plus JSON-RPC shapes.
//!
//! [`read_message`] tolerates arbitrarily split reads (any [`BufRead`]
//! chunking, including one byte at a time) and accepts `CRLF` or bare `LF`
//! header endings. The JSON value model lives in [`crate::json`] and is
//! re-exported here so existing `transport::Json` paths keep working.

use std::io::{self, BufRead, Write};

/// Maximum JSON-RPC body accepted (64 MiB); larger frames are rejected.
pub const MAX_MESSAGE_BYTES: usize = 64 << 20;

/// Maximum complete header section (64 KiB), including line endings and
/// the empty line separating headers from the body. This is a local support
/// budget, not an LSP-specified maximum.
pub const MAX_HEADER_BYTES: usize = 64 << 10;

// Bound each retained body acquisition, including readers with large buffers.
const BODY_CHUNK_BYTES: usize = 8 << 10;

/// Read one Content-Length-framed message body.
///
/// Returns `Ok(None)` on clean EOF before any header byte. Tolerates any
/// read chunking and `CRLF` or bare-`LF` header endings; other headers are
/// ignored within [`MAX_HEADER_BYTES`]. Equal repeated Content-Length values
/// are accepted; conflicting values, malformed lengths and budget violations
/// are `InvalidData` errors. Body storage grows only when payload arrives,
/// geometrically up to the declared length; an absent payload allocates none.
/// Callers must close the stream on framing errors: no resynchronization is
/// promised. EOF inside headers or a body is `UnexpectedEof`.
pub fn read_message<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut content_length: Option<usize> = None;
    let mut header_bytes = 0;
    let mut line = Vec::new();
    loop {
        line.clear();
        if !read_header_line(reader, &mut line, &mut header_bytes)? {
            return Ok(None);
        }
        while line.last() == Some(&b'\n') || line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            break;
        }
        let mut parts = line.splitn(2, |b| *b == b':');
        let name = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        if name.eq_ignore_ascii_case(b"Content-Length") {
            let digits = std::str::from_utf8(value.trim_ascii())
                .map_err(|_| invalid_data("bad Content-Length"))?;
            let length: usize = digits
                .parse()
                .map_err(|_| invalid_data("bad Content-Length"))?;
            if length > MAX_MESSAGE_BYTES {
                return Err(invalid_data("message exceeds size cap"));
            }
            if content_length.is_some_and(|previous| previous != length) {
                return Err(invalid_data("conflicting Content-Length"));
            }
            content_length = Some(length);
        }
    }
    let length = content_length.ok_or_else(|| invalid_data("missing Content-Length"))?;
    let mut body = Vec::new();
    while body.len() < length {
        let available = match reader.fill_buf() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if available.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "EOF inside LSP body",
            ));
        }
        let count = available
            .len()
            .min(length - body.len())
            .min(BODY_CHUNK_BYTES);
        let needed = body.len() + count;
        if needed > body.capacity() {
            let target = body
                .capacity()
                .max(BODY_CHUNK_BYTES)
                .saturating_mul(2)
                .min(length)
                .max(needed);
            body.try_reserve_exact(target - body.len())
                .map_err(|_| allocation_error())?;
        }
        body.extend_from_slice(&available[..count]);
        reader.consume(count);
    }
    Ok(Some(body))
}

/// Acquire a line without retaining any byte beyond the total header budget.
fn read_header_line<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    total: &mut usize,
) -> io::Result<bool> {
    loop {
        if *total == MAX_HEADER_BYTES {
            return Err(invalid_data("headers exceed size cap"));
        }
        let available = match reader.fill_buf() {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if available.is_empty() {
            return if *total == 0 {
                Ok(false)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "EOF inside LSP headers",
                ))
            };
        }
        let bounded = &available[..available.len().min(MAX_HEADER_BYTES - *total)];
        let count = bounded
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bounded.len(), |position| position + 1);
        line.try_reserve_exact(count)
            .map_err(|_| allocation_error())?;
        line.extend_from_slice(&bounded[..count]);
        *total += count;
        reader.consume(count);
        if line.last() == Some(&b'\n') {
            return Ok(true);
        }
    }
}

fn allocation_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::OutOfMemory,
        "LSP frame storage allocation failed",
    )
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Write one Content-Length-framed message body.
pub fn write_message<W: Write>(writer: &mut W, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)?;
    writer.flush()
}

