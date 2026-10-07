use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io::{self, BufRead, Read};
use std::time::Instant;
#[path = "transport-fragment.rs"] mod production;
thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static CALLS: Cell<usize> = const { Cell::new(0) };
    static TOTAL: Cell<usize> = const { Cell::new(0) };
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}
struct Observer;
fn observe(size: usize) { if TRACK.get() { CALLS.set(CALLS.get()+1); TOTAL.set(TOTAL.get()+size); LARGEST.set(LARGEST.get().max(size)); } }
unsafe impl GlobalAlloc for Observer {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { observe(l.size()); unsafe { System.alloc(l) } }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { observe(n); unsafe { System.realloc(p,l,n) } }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { unsafe { System.dealloc(p,l) } }
}
#[global_allocator] static ALLOCATOR: Observer = Observer;
struct OneByte<'a> { wire: &'a [u8], position: usize, fail_at: Option<usize>, calls: usize }
impl Read for OneByte<'_> { fn read(&mut self, out: &mut [u8]) -> io::Result<usize> { let bytes=self.fill_buf()?; let n=bytes.len().min(out.len()); out[..n].copy_from_slice(&bytes[..n]); self.consume(n); Ok(n) } }
impl BufRead for OneByte<'_> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> { self.calls+=1; if self.fail_at==Some(self.position) { return Err(io::Error::from(io::ErrorKind::PermissionDenied)); } Ok(&self.wire[self.position..(self.position+1).min(self.wire.len())]) }
    fn consume(&mut self, n:usize) { self.position+=n; }
}
fn probe(wire:&[u8]) -> (io::Result<Option<Vec<u8>>>, usize, usize, usize, usize, u128) {
    let mut reader=OneByte { wire, position:0, fail_at:None, calls:0 };
    CALLS.set(0); TOTAL.set(0); LARGEST.set(0);
    let start=Instant::now(); TRACK.set(true); let result=production::read_message(&mut reader); TRACK.set(false);
    (result, reader.position, CALLS.get(), TOTAL.get(), LARGEST.get(), start.elapsed().as_micros())
}
fn main() {
    let mut wire=b"Content-Length: 0\r\nX: ".to_vec(); wire.resize(65532,b'x'); wire.extend_from_slice(b"\r\n\r\n");
    let (result,position,calls,total,largest,us)=probe(&wire); assert_eq!(result.unwrap(),Some(vec![])); assert_eq!(position,65536); assert!(largest<=65536);
    println!("one-byte exact 65536-byte header: consumed={position}, allocations={calls}, sum-requested={total}, largest={largest}, elapsed-us={us}");
    wire.push(b'\n'); wire[65535]=b'x';
    let (result,position,calls,total,largest,us)=probe(&wire); assert_eq!(result.unwrap_err().kind(),io::ErrorKind::InvalidData); assert_eq!(position,65536); assert!(largest<=65536);
    println!("one-byte separator exceeds cap: consumed={position}, allocations={calls}, sum-requested={total}, largest={largest}, elapsed-us={us}");
    let mut wire=b"Content-Length: 65537\r\n\r\n".to_vec(); let body_start=wire.len(); wire.extend(std::iter::repeat_n(b'x',65537)); wire.extend_from_slice(b"Content-Length: 2\r\n\r\n[]");
    let (result,position,calls,total,largest,us)=probe(&wire); assert_eq!(result.unwrap().unwrap(),vec![b'x';65537]); assert_eq!(position,body_start+65537); assert!(calls<40); assert!(largest<=65537);
    println!("one-byte 65537-byte body: consumed={position}, allocations={calls}, sum-requested={total}, largest={largest}, elapsed-us={us}");
    for fail_at in [0,5,body_start,body_start+1,body_start+100] {
        let mut reader=OneByte { wire:&wire, position:0, fail_at:Some(fail_at), calls:0 };
        let result=production::read_message(&mut reader); assert_eq!(result.unwrap_err().kind(),io::ErrorKind::PermissionDenied); assert_eq!(reader.position,fail_at); assert_eq!(reader.calls,fail_at+1);
        println!("non-EOF reader error: fail-at={fail_at}, consumed={}, fill-calls={}",reader.position,reader.calls);
    }
}
