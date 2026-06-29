#!/usr/bin/env bash

set -euxo pipefail

STARSHIP_VERSION="1.25.1"
STARSHIP_BASE_URL="https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}"

ZELLIJ_VERSION="0.44.3"
ZELLIJ_BASE_URL="https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}"

function download_starship() {
	local PLATFORM="$1"
	local TARBALL="starship-${PLATFORM}.tar.gz"
	curl -fL --output "${TARBALL}" "${STARSHIP_BASE_URL}/${TARBALL}"
	curl -fL --output "${TARBALL}.sha256" "${STARSHIP_BASE_URL}/${TARBALL}.sha256"
	verify "${TARBALL}" "${TARBALL}.sha256"
}

# Unlike starship, zellij publishes the digest of the *extracted* binary rather
# than of the tarball, so we extract into the platform directory first and then
# verify the resulting `zellij` binary. We use the `no-web` build, which omits
# the bundled web client.
function download_zellij() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local TARBALL="zellij-no-web-${PLATFORM}.tar.gz"
	local DIGEST="zellij-no-web-${PLATFORM}.sha256sum"
	curl -fL --output "${TARBALL}" "${ZELLIJ_BASE_URL}/${TARBALL}"
	curl -fL --output "${DIGEST}" "${ZELLIJ_BASE_URL}/${DIGEST}"
	tar --directory "${OUTDIR}" -xf "${TARBALL}"
	verify "${OUTDIR}/zellij" "${DIGEST}"
}

# Verify a downloaded file against its published sha256 digest before we trust
# it. Uses sha256sum on Linux and shasum on macOS.
function verify() {
	local FILE="$1"
	local DIGEST="$2"
	local expected actual
	expected="$(cut -d' ' -f1 "${DIGEST}")"
	if command -v sha256sum > /dev/null; then
		actual="$(sha256sum "${FILE}" | cut -d' ' -f1)"
	else
		actual="$(shasum -a 256 "${FILE}" | cut -d' ' -f1)"
	fi
	if [[ "${expected}" != "${actual}" ]]; then
		echo "checksum mismatch for ${FILE}: expected ${expected}, got ${actual}" >&2
		exit 1
	fi
}

mkdir -p Darwin/{arm64,x86_64} Linux/{aarch64,x86_64}

# NOTE: Using musl because the binaries are statically linked. This prevents glibc issues.
download_starship aarch64-unknown-linux-musl
download_starship x86_64-unknown-linux-musl
download_starship aarch64-apple-darwin
download_starship x86_64-apple-darwin

tar --directory Darwin/arm64 -xf starship-aarch64-apple-darwin.tar.gz
tar --directory Darwin/x86_64 -xf starship-x86_64-apple-darwin.tar.gz
tar --directory Linux/aarch64 -xf starship-aarch64-unknown-linux-musl.tar.gz
tar --directory Linux/x86_64 -xf starship-x86_64-unknown-linux-musl.tar.gz

download_zellij aarch64-unknown-linux-musl Linux/aarch64
download_zellij x86_64-unknown-linux-musl Linux/x86_64
download_zellij aarch64-apple-darwin Darwin/arm64
download_zellij x86_64-apple-darwin Darwin/x86_64
