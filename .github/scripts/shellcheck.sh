#!/bin/sh
# Lints every tracked shell script: files with a shell shebang or a .sh
# suffix, minus vendored ones. Runs the same way in CI and locally.
set -eu

cd "$(dirname "$0")/../.."

files=""
while IFS= read -r f; do
    case "$f" in
        tuicr-skill/*|.vim/*) continue ;;
    esac
    case "$f" in
        *.sh) files="$files $f" ;;
        *)
            [ -f "$f" ] || continue
            head -n1 "$f" | grep -qE '^#!.*\b(sh|bash|dash|ksh)$' && files="$files $f"
            ;;
    esac
done <<EOF
$(git ls-files)
EOF

# shellcheck disable=SC2086
shellcheck $files
shellcheck -s bash .shellrc-common
