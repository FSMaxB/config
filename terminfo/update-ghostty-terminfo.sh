#!/bin/sh
# Regenerates ghostty.terminfo (next to this script) from Ghostty's terminfo definition. Upstream
# only publishes it as Zig source (src/terminfo/ghostty.zig), whose text form is produced by its
# build, so this script renders the same format Ghostty's Source.encode() writes.
# To bump the version: set GHOSTTY_VERSION and GHOSTTY_COMMIT (`git ls-remote --tags
# https://github.com/ghostty-org/ghostty '<tag>^{}'`), then run the script and commit the result.
set -eu

GHOSTTY_VERSION=v1.4.0
GHOSTTY_COMMIT=83fb95624b0439ee660c2679b43b38c8b63769cd

source_url=https://raw.githubusercontent.com/ghostty-org/ghostty/${GHOSTTY_COMMIT}/src/terminfo/ghostty.zig
output=$(cd "$(dirname "$0")" && pwd)/ghostty.terminfo

# Zig string literals escape every backslash, the final sed undoes that.
render() {
  echo "# Rendered from ghostty ${GHOSTTY_VERSION} (${GHOSTTY_COMMIT}), src/terminfo/ghostty.zig"
  echo "# by terminfo/update-ghostty-terminfo.sh. Do not edit by hand."
  awk '
    /\.names = &\.\{/ { in_names = 1; next }
    in_names && /^[[:space:]]*\},/ {
      in_names = 0
      printf "%s,\n", joined
      next
    }
    in_names && /^[[:space:]]*"/ {
      name = $0
      sub(/^[[:space:]]*"/, "", name)
      sub(/",[[:space:]]*$/, "", name)
      joined = (joined == "" ? name : joined "|" name)
      next
    }
    /\.capabilities = &\.\{/ { in_capabilities = 1; next }
    in_capabilities && /^[[:space:]]*\.\{ \.name = "/ {
      line = $0
      sub(/^[[:space:]]*\.\{ \.name = "/, "", line)
      quote = index(line, "\"")
      name = substr(line, 1, quote - 1)
      rest = substr(line, quote + 1)
      if (rest ~ /\.boolean/) {
        printf "\t%s,\n", name
      } else if (rest ~ /\.canceled/) {
        printf "\t%s@,\n", name
      } else if (match(rest, /\.numeric = [0-9]+/)) {
        printf "\t%s#%s,\n", name, substr(rest, RSTART + 11, RLENGTH - 11)
      } else if (rest ~ /\.string = "/) {
        value = substr(rest, index(rest, ".string = \"") + 11)
        sub(/" \} \},[[:space:]]*$/, "", value)
        printf "\t%s=%s,\n", name, value
      } else {
        printf "unsupported capability: %s\n", $0 > "/dev/stderr"
        exit 1
      }
    }
  ' | sed 's/\\\\/\\/g'
}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

curl -fsSL "$source_url" >"$scratch/ghostty.zig"
render <"$scratch/ghostty.zig" >"$scratch/ghostty.terminfo"
mv "$scratch/ghostty.terminfo" "$output"
echo "wrote $output"
