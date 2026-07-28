#!/usr/bin/env bash

set -euxo pipefail

STARSHIP_VERSION="1.25.1"
STARSHIP_BASE_URL="https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}"

ZELLIJ_VERSION="0.44.3"
ZELLIJ_BASE_URL="https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}"

BAT_VERSION="0.26.1"
BAT_BASE_URL="https://github.com/sharkdp/bat/releases/download/v${BAT_VERSION}"

JJ_VERSION="0.43.0"
JJ_BASE_URL="https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}"

JQ_VERSION="1.8.2"
JQ_BASE_URL="https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}"

TUICR_VERSION="0.19.1"
TUICR_BASE_URL="https://github.com/agavra/tuicr/releases/download/v${TUICR_VERSION}"
TUICR_RAW_URL="https://raw.githubusercontent.com/agavra/tuicr/v${TUICR_VERSION}/skills/tuicr"

CRIT_VERSION="0.18.1"
CRIT_BASE_URL="https://github.com/tomasz-tomczyk/crit/releases/download/v${CRIT_VERSION}"

function download_starship() {
	local PLATFORM="$1"
	local TARBALL="starship-${PLATFORM}.tar.gz"
	curl -fL --output "${TARBALL}" "${STARSHIP_BASE_URL}/${TARBALL}"
	curl -fL --output "${TARBALL}.sha256" "${STARSHIP_BASE_URL}/${TARBALL}.sha256"
	verify "${TARBALL}" "$(cut -d' ' -f1 "${TARBALL}.sha256")"
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
	verify "${OUTDIR}/zellij" "$(cut -d' ' -f1 "${DIGEST}")"
}

# bat publishes no checksum assets at all; the digests passed in below are
# pinned from the sha256 digests in the GitHub release asset metadata. The
# tarball nests everything in a directory, so extract just the binary.
function download_bat() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local SHA256="$3"
	local NAME="bat-v${BAT_VERSION}-${PLATFORM}"
	curl -fL --output "${NAME}.tar.gz" "${BAT_BASE_URL}/${NAME}.tar.gz"
	verify "${NAME}.tar.gz" "${SHA256}"
	tar --directory "${OUTDIR}" --strip-components 1 -xf "${NAME}.tar.gz" "${NAME}/bat"
}

# jj publishes no checksum assets either, so its digests are pinned the same
# way as bat's. The tarball root also carries LICENSE/README, so extract just
# the binary.
function download_jj() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local SHA256="$3"
	local TARBALL="jj-v${JJ_VERSION}-${PLATFORM}.tar.gz"
	curl -fL --output "${TARBALL}" "${JJ_BASE_URL}/${TARBALL}"
	verify "${TARBALL}" "${SHA256}"
	tar --directory "${OUTDIR}" -xf "${TARBALL}" ./jj
}

# jq publishes raw binaries instead of tarballs, plus a single sha256sum.txt
# covering all of them (downloaded once as jq-sha256sum.txt below).
function download_jq() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local BINARY="jq-${PLATFORM}"
	curl -fL --output "${BINARY}" "${JQ_BASE_URL}/${BINARY}"
	verify "${BINARY}" "$(grep " ${BINARY}\$" jq-sha256sum.txt | cut -d' ' -f1)"
	install -m 755 "${BINARY}" "${OUTDIR}/jq"
}

# crit publishes raw binaries plus a checksums.txt file. The binary names
# use darwin/linux and amd64/arm64 rather than the platform triplets used by
# other tools.
function download_crit() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local BINARY="crit-${PLATFORM}"
	curl -fL --output "${BINARY}" "${CRIT_BASE_URL}/${BINARY}"
	verify "${BINARY}" "$(grep " ${BINARY}\$" checksums.txt | cut -d' ' -f1)"
	install -m 755 "${BINARY}" "${OUTDIR}/crit"
}

# tuicr publishes no checksum assets, so its release asset metadata digests are
# pinned here. Each tarball contains only the binary at its root.
function download_tuicr() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local SHA256="$3"
	local TARBALL="tuicr-${TUICR_VERSION}-${PLATFORM}.tar.gz"
	curl -fL --output "${TARBALL}" "${TUICR_BASE_URL}/${TARBALL}"
	verify "${TARBALL}" "${SHA256}"
	tar --directory "${OUTDIR}" -xf "${TARBALL}" tuicr
}

# The tuicr release tarballs contain only the binary, so the Claude skill files
# are fetched as raw files from the pinned tag instead. Raw files have no digest
# assets, so their sha256 digests are pinned by hand below.
function download_tuicr_skill() {
	local FILE="$1"
	local MODE="$2"
	local SHA256="$3"
	local DOWNLOAD="tuicr-skill-${FILE}"
	curl -fL --output "${DOWNLOAD}" "${TUICR_RAW_URL}/${FILE}"
	verify "${DOWNLOAD}" "${SHA256}"
	install -m "${MODE}" "${DOWNLOAD}" "../tuicr-skill/${FILE}"
}

# Verify a downloaded file against its expected sha256 digest before we trust
# it. Uses sha256sum on Linux and shasum on macOS.
function verify() {
	local FILE="$1"
	local expected="$2"
	local actual
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

download_bat aarch64-unknown-linux-musl Linux/aarch64 6369242c584065f195fb20cb36fbd7cb63ae690605bbe89868a7596b596c2c23
download_bat x86_64-unknown-linux-musl Linux/x86_64 0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191
download_bat aarch64-apple-darwin Darwin/arm64 e30beff26779c9bf60bb541e1d79046250cb74378f2757f8eb250afddb19e114
download_bat x86_64-apple-darwin Darwin/x86_64 830d63b0bba1fa040542ec569e3cf77f60d3356b9de75116a344b061e0894245

download_jj aarch64-unknown-linux-musl Linux/aarch64 289197b6bec60b4e57d47260624b617716f737eb02cdfd9155791b2576aa5862
download_jj x86_64-unknown-linux-musl Linux/x86_64 59e5588583ac82b623239929368c65b90735931c0f26b5a16c1f04d5bb97643d
download_jj aarch64-apple-darwin Darwin/arm64 84336bbe5673a36ccc6395c494021ba632794da078eb8c8c513a60f8e1cc3083
download_jj x86_64-apple-darwin Darwin/x86_64 f1a7fec046b816132318c07a9c096680f7aae78b008709c7166a57efd9c579ec

curl -fL --output jq-sha256sum.txt "${JQ_BASE_URL}/sha256sum.txt"
download_jq linux-arm64 Linux/aarch64
download_jq linux-amd64 Linux/x86_64
download_jq macos-arm64 Darwin/arm64
download_jq macos-amd64 Darwin/x86_64

# crit publishes raw binaries and a checksums.txt file.
curl -fL --output checksums.txt "${CRIT_BASE_URL}/checksums.txt"
download_crit darwin-arm64 Darwin/arm64
download_crit darwin-amd64 Darwin/x86_64
download_crit linux-arm64 Linux/aarch64
download_crit linux-amd64 Linux/x86_64

# Upstream currently publishes glibc-linked Linux binaries rather than musl.
download_tuicr aarch64-unknown-linux-gnu Linux/aarch64 070c5cee0862c51cfb9718591c7faa4c163a44153cb9b596d107cfb5c86c99ab
download_tuicr x86_64-unknown-linux-gnu Linux/x86_64 67addacc28ee9c6d1ce84220954f1ff0c6a82b374822142dd8cb615b3d425ec5
download_tuicr aarch64-apple-darwin Darwin/arm64 f89a6682defb9b81084ee89dde6bde64b7fe6e8b90788a7a3490d2d6cacbf2d4
download_tuicr x86_64-apple-darwin Darwin/x86_64 46cb4732c98839220b5d5b8dd099450dd35b4de24dcf873ef47b0ad944519f08

mkdir -p ../tuicr-skill
download_tuicr_skill SKILL.md 644 30b8169d6fa9bf1b44e4b3542856b44850705ccff5194d9bb4649034dbd640fd
download_tuicr_skill tuicr-wrapper.sh 755 c9d2fdb1fa1688b696ccfe5cd4988abcdef636c7d62780f03a788f62aef23c45
download_tuicr_skill tuicr-wrapper-zellij.sh 755 7a56005bf268c1a0c303448569c356cac34364075c9d3a1c27bb5a4a9c1eca49
