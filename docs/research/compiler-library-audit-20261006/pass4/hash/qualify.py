#!/usr/bin/env python3
"""Independent expected vectors and baseline/candidate scratch qualification."""
import hashlib, json, pathlib, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[5]
evidence = pathlib.Path(__file__).resolve().parent
cases = [("empty", b""), ("abc", b"abc"),
 ("nist_long", b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
 ("binary", bytes(range(256))), ("utf8", "Can é 🦀\n".encode()),
 ("crlf", b"Can\r\nsource\r\n"), ("lf", b"Can\nsource\n")]
cases += [(f"padding_{n}", b"a" * n) for n in [55,56,63,64,65,127,128,129]]
cases += [("million_a", b"a" * 1000000)]
with tempfile.TemporaryDirectory(prefix="can-c04h-", dir="/private/tmp") as tmp:
 p = pathlib.Path(tmp); (p / "src").mkdir()
 (p / "Cargo.toml").write_text('[package]\nname="can-c04h"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nsha2={version="=0.10.9",default-features=false}\n[profile.release]\nstrip=true\nopt-level="z"\nlto=true\ncodegen-units=1\n')
 if (evidence / "scratch-Cargo.lock").exists():
  (p / "Cargo.lock").write_bytes((evidence / "scratch-Cargo.lock").read_bytes())
 old = subprocess.check_output(["git", "show", "0104b04:compiler/src/source.rs"], cwd=root, text=True)
 start = old.index("pub fn sha256_hex")
 baseline = old[start:old.index("\n#[cfg(test)]", start)]
 main = ["fn main() {"]
 for name, data in cases:
  expr = "vec![b'a'; 1000000]" if name == "million_a" else "vec![" + ",".join(map(str,data)) + "]"
  expected = hashlib.sha256(data).hexdigest()
  main.append(f'let bytes = {expr}; assert_eq!(sha256_hex(&bytes), "{expected}", "{name}"); println!("{name}: {expected}");')
 main.append("}")
 (p / "baseline.rs").write_text(baseline + "\n" + "\n".join(main))
 subprocess.run(["rustc", "--edition=2024", str(p/"baseline.rs"), "-o", str(p/"baseline")], check=True)
 out = subprocess.check_output([str(p/"baseline")], text=True)
 (evidence/"baseline-results.txt").write_text(out)
 current = (root / 'compiler/src/source.rs').read_text()
 start = current.index('pub fn sha256_hex')
 adapter = current[start:current.index('\n#[cfg(test)]', start)]
 (p/"src/main.rs").write_text(adapter + "\n" + "\n".join(main))
 out = subprocess.check_output(["cargo", "run", "--locked", "--offline", "--release", "--manifest-path", str(p/"Cargo.toml")], text=True)
 (evidence/"candidate-results.txt").write_text(out)
 metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--locked", "--offline", "--format-version", "1", "--manifest-path", str(p/"Cargo.toml")]))
 (evidence/"dependency-profile.json").write_text(json.dumps([{"name":x["name"],"version":x["version"],"declared_rust_version":x["rust_version"],"license":x["license"]} for x in metadata["packages"] if x["name"] != "can-c04h"], indent=2)+"\n")
 (evidence/"scratch-Cargo.lock").write_text((p/"Cargo.lock").read_text())
print("baseline and candidate passed all", len(cases), "independent vectors")
