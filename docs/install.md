# Install `can`

`can` is a single dependency-free binary. Two ways to get it:

## From a release artifact

1. Download your platform's artifact from the `release` workflow run
   (`can-linux-x86_64` or `can-macos-aarch64`): the `can` binary plus its
   `SHA256SUMS-<platform>.txt`.
2. Verify the checksum:
   `shasum -a 256 -c SHA256SUMS-<platform>.txt`
3. Install somewhere on your `PATH`, e.g.:
   `install -m 755 can ~/.local/bin/can`
   (create `~/.local/bin` first if needed and add it to `PATH` in your
   shell rc: `export PATH="$HOME/.local/bin:$PATH"`).
4. Check: `can --version` prints
   `can 0.1.0 (commit <sha>; language 1.0; schema 1)`.

## From source

Needs Rust 1.99+ (see `compiler/Cargo.toml` `rust-version`):

```
git clone <repo> && cd canlang/compiler
cargo build --release --locked
install -m 755 target/release/can ~/.local/bin/can
```

## Shell completions

```
# bash:  can completions bash >> ~/.bash_completion
# zsh:   can completions zsh > ~/.zsh/completions/_can   (dir on fpath)
# fish:  can completions fish > ~/.config/fish/completions/can.fish
```

Or eval per shell: `eval "$(can completions bash)"`.

## Environment

- `CAN_CATALOG`: producer catalog path for
  `check`/`compile`/`lint`/`policy` (below `--catalog`, above
  `./can-catalog.json`).
- `CAN_PLATFORM_BIN`: override path to the `can-platform` binary for the
  thin lane-7 entries (`run`/`test`/`build`/`deploy`/`activate`).
