#!/usr/bin/env bash

set -euxo pipefail

STARSHIP_VERSION="1.25.1"
BASE_URL="https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}"

function download() {
	local PLATFORM="$1"
	local TARBALL="starship-${PLATFORM}.tar.gz"
	curl -fL --output "${TARBALL}" "${BASE_URL}/${TARBALL}"
	curl -fL --output "${TARBALL}.sha256" "${BASE_URL}/${TARBALL}.sha256"
	verify "${TARBALL}"
}

# Verify a downloaded tarball against its published .sha256 digest before we
# trust it. Uses sha256sum on Linux and shasum on macOS.
function verify() {
	local TARBALL="$1"
	local expected actual
	expected="$(cut -d' ' -f1 "${TARBALL}.sha256")"
	if command -v sha256sum > /dev/null; then
		actual="$(sha256sum "${TARBALL}" | cut -d' ' -f1)"
	else
		actual="$(shasum -a 256 "${TARBALL}" | cut -d' ' -f1)"
	fi
	if [[ "${expected}" != "${actual}" ]]; then
		echo "checksum mismatch for ${TARBALL}: expected ${expected}, got ${actual}" >&2
		exit 1
	fi
}

# NOTE: Using musl because the binaries are statically linked. This prevents glibc issues.
download aarch64-unknown-linux-musl
download x86_64-unknown-linux-musl
download aarch64-apple-darwin
download x86_64-apple-darwin

mkdir -p Darwin/{arm64,x86_64} Linux/{aarch64,x86_64}

tar --directory Darwin/arm64 -xf starship-aarch64-apple-darwin.tar.gz
tar --directory Darwin/x86_64 -xf starship-x86_64-apple-darwin.tar.gz
tar --directory Linux/aarch64 -xf starship-aarch64-unknown-linux-musl.tar.gz
tar --directory Linux/x86_64 -xf starship-x86_64-unknown-linux-musl.tar.gz
