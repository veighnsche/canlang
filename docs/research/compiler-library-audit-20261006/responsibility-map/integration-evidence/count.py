#!/usr/bin/env python3
"""Parser-free physical LOC split for compiler/src Rust files.

Masks Rust comments and ordinary/raw strings while preserving offsets, then
finds exact top-level #[cfg(test)] items by brace/semicolon extent. This is a
review aid rather than a Rust parser: complex macro/token-tree and uncommon
item forms require manual review. Uses only Python stdlib.
"""
from pathlib import Path
import re, sys

ROOT = (Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[5]) / 'compiler/src'

def mask(src):
    out=list(src); i=0; n=len(src)
    def blank(a,b):
        for k in range(a,b):
            if out[k] not in '\r\n': out[k]=' '
    while i<n:
        if src.startswith('//',i):
            j=src.find('\n',i); j=n if j<0 else j; blank(i,j); i=j; continue
        if src.startswith('/*',i):
            j=i+2; depth=1
            while j<n and depth:
                if src.startswith('/*',j): depth+=1; j+=2
                elif src.startswith('*/',j): depth-=1; j+=2
                else: j+=1
            blank(i,j); i=j; continue
        # Raw strings: r###"..."### and br###"..."###
        m=re.compile(r'(?:b)?r(#{0,})"').match(src,i)
        if m:
            hashes=m.group(1); start=i; j=m.end(); end='"'+hashes
            k=src.find(end,j); i=n if k<0 else k+len(end); blank(start,i); continue
        # Quoted strings and byte strings.
        if src[i]=='"' or (src[i]=='b' and i+1<n and src[i+1]=='"'):
            start=i; i+=2 if src[i]=='b' else 1
            while i<n:
                if src[i]=='\\': i+=2
                elif src[i]=='"': i+=1; break
                else: i+=1
            blank(start,i); continue
        # Character literals only when a closing quote is nearby; do not mask lifetimes.
        if src[i]=="'":
            m=re.compile(r"'(?:\\u\{[0-9A-Fa-f_]+\}|\\x[0-9A-Fa-f]{2}|\\.|[^'\\\n])'").match(src,i)
            if m: start=i; i+=len(m.group()); blank(start,i); continue
        i+=1
    return ''.join(out)

def test_spans(src):
    clean=mask(src); spans=[]; lines=src.splitlines(keepends=True)
    offsets=[0]
    for line in lines: offsets.append(offsets[-1]+len(line))
    # Only exact top-level attribute lines; preceding comments are not counted.
    for li,line in enumerate(lines):
        if line.strip()!='#[cfg(test)]': continue
        start=offsets[li]
        # Attributes can precede cfg(test); baseline snapshot review found no complex cases.
        depth=0; quote=False; escaped=False; end=None
        for p in range(offsets[li+1],len(clean)):
            ch=clean[p]
            if ch=='{': depth+=1
            elif ch=='}':
                depth-=1
                if depth==0: end=p+1; break
            elif ch==';' and depth==0: end=p+1; break
        if end is None: raise RuntimeError(f'unclosed cfg(test) item at line {li+1}')
        spans.append((start,end))
    return spans

def physical(s): return s.count('\n') + (1 if s and not s.endswith('\n') else 0)

def lines_in_span(src,a,b): return physical(src[a:b])

if __name__ == "__main__":
    prod=inline=files=0
    for path in sorted(ROOT.rglob('*.rs')):
        src=path.read_text(); spans=test_spans(src); tests=sum(lines_in_span(src,a,b) for a,b in spans)
        total=physical(src); prod+=total-tests; inline+=tests; files+=1
    print({'files':files,'physical_lines':prod+inline,'production_lines':prod,'inline_test_lines':inline})
