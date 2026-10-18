#!/bin/sh
# Install a checksum-verified, self-contained Can release without sudo.
# Parse the complete installer before running it, including when streamed by curl.
main() {
set -eu

fail() { printf 'can installer: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
       curl -fsSL https://sodaos.dev/CanLang/install.sh | bash -s -- --version VERSION
       install.sh [--version VERSION] [--base-url HTTPS_URL]
       install.sh --archive FILE --checksum SHA256 [--version VERSION]

Installs under ${CAN_INSTALL_DIR:-$HOME/.can} and configures your shell PATH.
Remote installs default to the latest GitHub release. --base-url is a releases
download root: archives are fetched from BASE/vVERSION/can-VERSION-PLATFORM.tar.gz.
Supports macOS arm64 and Linux x64 (glibc). No language runtime is required.
EOF
}
version= archive= checksum=
base_url=https://github.com/veighnsche/canlang/releases/download
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--archive|--checksum|--base-url)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "missing value for $1"
      case "$1" in
        --version) version=$2 ;; --archive) archive=$2 ;;
        --checksum) checksum=$2 ;; --base-url) base_url=$2 ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
for command in tar awk sed tr uname mktemp; do command -v "$command" >/dev/null 2>&1 || fail "required command missing: $command"; done
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Linux-x86_64)
    platform=linux-x64
    if command -v getconf >/dev/null 2>&1; then
      getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'Linux releases require glibc'
    else fail 'cannot verify glibc (getconf is missing)'; fi ;;
  *) fail 'supported platforms are macOS arm64 and Linux x64 (glibc)' ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{print $1}'; }
else fail 'required command missing: sha256sum or shasum'; fi
if [ -n "$archive" ]; then
  [ -n "$checksum" ] || fail '--archive requires --checksum SHA256'
  [ -f "$archive" ] || fail "archive not found: $archive"
  case "$archive" in /*) ;; *) archive=$PWD/$archive ;; esac
else
  [ -z "$checksum" ] || fail '--checksum requires --archive'
  command -v curl >/dev/null 2>&1 || fail 'required command missing: curl'
  case "$base_url" in https://*) ;; *) fail '--base-url must use HTTPS' ;; esac
  if [ -z "$version" ]; then
    [ "$base_url" = https://github.com/veighnsche/canlang/releases/download ] || fail '--base-url requires --version'
    latest=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output /dev/null --write-out '%{url_effective}' https://github.com/veighnsche/canlang/releases/latest) || fail 'could not resolve latest release; use --version'
    version=${latest##*/}
    case "$version" in v*) version=${version#v} ;; *) fail 'latest release did not resolve to a version tag; use --version' ;; esac
  fi
fi
if [ -n "$version" ]; then
  case "$version" in *[!a-zA-Z0-9._+-]*|[!a-zA-Z0-9]*|'') fail 'version must begin with a letter or number and contain only letters, numbers, dot, underscore, plus or hyphen' ;; esac
fi
[ -n "${HOME:-}" ] || fail 'HOME must be set'
root=${CAN_INSTALL_DIR:-$HOME/.can}
case "$root" in /*) ;; *) root=$PWD/$root ;; esac
while [ "$root" != / ] && [ "${root%/}" != "$root" ]; do root=${root%/}; done
case "$root" in *'
'*|*'
'*) fail 'installation path must not contain newlines or carriage returns' ;; esac
[ ! -L "$root" ] || fail "refusing symlink installation directory: $root"
magic=can-installer-v1
if [ ! -e "$root" ]; then
  (umask 077; mkdir -p "$(dirname "$root")" && mkdir "$root" && printf '%s\n' "$magic" > "$root/.can-installer") || fail 'cannot create installation directory (another installer may be starting)'
fi
[ -d "$root" ] && [ -f "$root/.can-installer" ] && [ ! -L "$root/.can-installer" ] && [ "$(cat "$root/.can-installer")" = "$magic" ] || fail "refusing foreign installation directory: $root"
root=$(CDPATH= cd "$root" && pwd -P)
lock=$root/.install-lock
mkdir "$lock" 2>/dev/null || fail "another installation is active, or an interrupted lock remains: $lock (remove it only after the installer has stopped)"
stage= current_tmp=
cleanup() {
  [ -z "$current_tmp" ] || rm -f "$current_tmp"
  [ -z "$stage" ] || rm -rf "$stage"
  rmdir "$lock" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for directory in versions bin; do
  [ ! -L "$root/$directory" ] || fail "refusing symlink: $root/$directory"
  [ ! -e "$root/$directory" ] || [ -d "$root/$directory" ] || fail "refusing foreign file: $root/$directory"
  mkdir -p "$root/$directory"
done
if [ -e "$root/current" ] || [ -L "$root/current" ]; then
  [ -L "$root/current" ] || fail 'refusing foreign current entry'
  previous=$(readlink "$root/current")
  case "$previous" in versions/*) ;; *) fail 'refusing foreign current symlink' ;; esac
  case "${previous#versions/}" in */*|''|.|..) fail 'refusing foreign current symlink' ;; esac
  [ -f "$root/$previous/.can-install-version" ] && [ ! -L "$root/$previous/.can-install-version" ] && [ ! -L "$root/$previous" ] || fail 'refusing unowned current version'
fi
if [ -e "$root/bin/can" ] || [ -L "$root/bin/can" ]; then
  [ -L "$root/bin/can" ] && [ "$(readlink "$root/bin/can")" = ../current/bin/can ] || fail "refusing foreign launcher: $root/bin/can"
fi
stage=$(mktemp -d "$root/.stage.XXXXXXXX")
if [ -z "$archive" ]; then
  name=can-$version-$platform.tar.gz
  url=${base_url%/}/v$version/$name
  archive=$stage/release.tar.gz
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$url" --output "$archive" || fail "download failed: $url"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$url.sha256" --output "$stage/checksum" || fail 'checksum download failed'
  checksum=$(awk 'NR == 1 {print $1} NR > 1 {exit 1}' "$stage/checksum") || fail 'invalid checksum file'
fi
case "$checksum" in *[!a-fA-F0-9]*|'') fail 'checksum must be exactly 64 hexadecimal characters' ;; esac
[ "${#checksum}" -eq 64 ] || fail 'checksum must be exactly 64 hexadecimal characters'
checksum=$(printf '%s' "$checksum" | tr A-F a-f)
actual=$(digest "$archive")
[ "$actual" = "$checksum" ] || fail 'checksum mismatch; installation unchanged'
[ -n "$version" ] || version=local-$(printf '%s' "$checksum" | cut -c1-12)
id=$version-$platform-$(printf '%s' "$checksum" | cut -c1-12)
destination=$root/versions/$id
# Only regular files and directories are accepted. Reject links before extraction,
# along with absolute paths, dot segments and names tar may quote ambiguously.
tar -tzf "$archive" > "$stage/members" || fail 'cannot list archive'
[ -s "$stage/members" ] || fail 'archive is empty'
while IFS= read -r member; do
  case "$member" in can|can/|can/*) ;; *) fail "archive entry is outside can/: $member" ;; esac
  case "$member" in *[!a-zA-Z0-9._+@/\ -]*|*/../*|*/..|*/./*|*/.|*//* ) fail "unsafe archive entry: $member" ;; esac
done < "$stage/members"
tar -tvzf "$archive" > "$stage/types" || fail 'cannot inspect archive'
awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" {exit 1}' "$stage/types" || fail 'archive links and special files are not supported'
mkdir "$stage/unpacked"
tar -xzf "$archive" -C "$stage/unpacked" --no-same-owner --no-same-permissions || fail 'archive extraction failed'
payload=$stage/unpacked/can
[ -f "$payload/manifest.json" ] && [ -f "$payload/bin/can" ] && [ -x "$payload/bin/can" ] || fail 'archive must contain manifest.json and executable bin/can'
"$payload/bin/can" --version >/dev/null || fail 'release launcher check failed; installation unchanged'
"$payload/bin/can" dev --help >/dev/null || fail 'release development-server check failed; installation unchanged'
printf '%s\n' "$checksum" > "$payload/.can-install-version"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ -d "$destination" ] && [ ! -L "$destination" ] && [ -f "$destination/.can-install-version" ] && [ ! -L "$destination/.can-install-version" ] && [ "$(cat "$destination/.can-install-version")" = "$checksum" ] || fail "refusing foreign version: $destination"
else
  mv "$payload" "$destination"
fi
[ -L "$root/bin/can" ] || ln -s ../current/bin/can "$root/bin/can"
current_tmp=$stage/current
ln -s "versions/$id" "$current_tmp"
case "$platform" in
  darwin-*) mv -fh "$current_tmp" "$root/current" ;;
  *) mv -fT "$current_tmp" "$root/current" ;;
esac
current_tmp=

# Quote literal paths for both POSIX shells and fish.
quoted=$(printf '%s' "$root/bin" | sed "s/'/'\\\\''/g")
shell_name=${SHELL:-}
shell_name=${shell_name##*/}
shell_name=${shell_name:-sh}
case "$shell_name" in
  fish)
    rc=$HOME/.config/fish/config.fish
    line="contains -- '$quoted' \$PATH; or set -gx PATH '$quoted' \$PATH" ;;
  zsh)
    rc=${ZDOTDIR:-$HOME}/.zshrc
    line="case \":\$PATH:\" in *:'$quoted':*) ;; *) export PATH='$quoted':\"\$PATH\" ;; esac" ;;
  *)
    rc=$HOME/.bashrc
    line="case \":\$PATH:\" in *:'$quoted':*) ;; *) export PATH='$quoted':\"\$PATH\" ;; esac" ;;
esac
add_path() {
  config=$1
  if [ -L "$config" ]; then printf 'PATH setup skipped symlink: %s\n' "$config" >&2; return; fi
  if ! mkdir -p "$(dirname "$config")" || ! touch "$config"; then printf 'Could not configure PATH in %s\n' "$config" >&2; return; fi
  if ! grep -Fqx -- "$line" "$config"; then
    printf '\n# Can installer\n%s\n' "$line" >> "$config" || printf 'Could not configure PATH in %s\n' "$config" >&2
  fi
}
add_path "$rc"
if [ "$shell_name" = bash ] || [ "$shell_name" = sh ]; then
  login=$HOME/.bash_profile
  [ ! -f "$HOME/.profile" ] || login=$HOME/.profile
  [ ! -f "$HOME/.bash_login" ] || login=$HOME/.bash_login
  [ ! -f "$HOME/.bash_profile" ] || login=$HOME/.bash_profile
  add_path "$login"
fi
printf 'Installed Can %s for %s in %s\n' "$version" "$platform" "$root"
printf 'Open a new terminal, or run:\n  %s\n' "$line"
printf 'Then run: can --version\n'

}

main "$@"
