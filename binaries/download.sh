#!/usr/bin/env bash

set -euxo pipefail

STARSHIP_VERSION="1.26.0"
STARSHIP_BASE_URL="https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}"

ZELLIJ_VERSION="0.45.1"
ZELLIJ_BASE_URL="https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}"

BAT_VERSION="0.26.1"
BAT_BASE_URL="https://github.com/sharkdp/bat/releases/download/v${BAT_VERSION}"

JJ_VERSION="0.45.1"
JJ_BASE_URL="https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}"

JQ_VERSION="1.8.2"
JQ_BASE_URL="https://github.com/jqlang/jq/releases/download/jq-${JQ_VERSION}"

TUICR_VERSION="0.26.0"
TUICR_BASE_URL="https://github.com/agavra/tuicr/releases/download/v${TUICR_VERSION}"
TUICR_RAW_URL="https://raw.githubusercontent.com/agavra/tuicr/v${TUICR_VERSION}/skills/tuicr"

CRIT_VERSION="0.20.2"
CRIT_BASE_URL="https://github.com/tomasz-tomczyk/crit/releases/download/v${CRIT_VERSION}"

RTK_VERSION="0.49.0"
RTK_BASE_URL="https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}"

# Every tool spells the same platform differently, and bat, jj and tuicr publish no
# checksum assets at all, so each platform keeps its identifier spellings and its pinned
# digests together.
function download_platform() {
	local PLATFORM="$1"
	local TRIPLE JQ_NAME CRIT_NAME RTK_NAME BAT_SHA256 JJ_SHA256 TUICR_SHA256
	case "${PLATFORM}" in
		Linux/aarch64)
			TRIPLE="aarch64-unknown-linux-musl"
			JQ_NAME="linux-arm64"
			CRIT_NAME="linux-arm64"
			RTK_NAME="aarch64-unknown-linux-gnu"
			BAT_SHA256="6369242c584065f195fb20cb36fbd7cb63ae690605bbe89868a7596b596c2c23"
			JJ_SHA256="7349a43dd5a20dbc998b10114daa0ee63d2ab863fb822c7eb6b0ebca5903cc69"
			TUICR_SHA256="c68f690e65846bc5d097c281ff3b75fb228d1d94cfafab6d7ebf8933e5e3a881"
			;;
		Linux/x86_64)
			TRIPLE="x86_64-unknown-linux-musl"
			JQ_NAME="linux-amd64"
			CRIT_NAME="linux-amd64"
			RTK_NAME="x86_64-unknown-linux-musl"
			BAT_SHA256="0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191"
			JJ_SHA256="f35438350b5d61963aac5dd74ede510b31d6b9690769d1a6268cf058cc825f72"
			TUICR_SHA256="2cfb422eda4ccb0faab3eedb218f2cbbb09e54eeb14bfb6995a99af389b3f998"
			;;
		Darwin/arm64)
			TRIPLE="aarch64-apple-darwin"
			JQ_NAME="macos-arm64"
			CRIT_NAME="darwin-arm64"
			RTK_NAME="aarch64-apple-darwin"
			BAT_SHA256="e30beff26779c9bf60bb541e1d79046250cb74378f2757f8eb250afddb19e114"
			JJ_SHA256="51ba42e3d0682616f6eb015045bfe45289b396f03511f9897f645ce8e9272743"
			TUICR_SHA256="2516c51d6f77cf78b69e7135fe9341de276fa3b7718e21597bf9719d4795bae2"
			;;
		Darwin/x86_64)
			TRIPLE="x86_64-apple-darwin"
			JQ_NAME="macos-amd64"
			CRIT_NAME="darwin-amd64"
			RTK_NAME="x86_64-apple-darwin"
			BAT_SHA256="830d63b0bba1fa040542ec569e3cf77f60d3356b9de75116a344b061e0894245"
			JJ_SHA256="6171582d0b5a98a1005cd9643faebff7936812ec264d7968a39d9cef3654a99b"
			TUICR_SHA256="5fe41523cc5ff58f92078e93a8dd4479a886765f49bdf59bd92b5677f1a98704"
			;;
		*)
			echo "unsupported platform ${PLATFORM}" >&2
			exit 1
			;;
	esac

	local OUTDIR="${BINARIES_DIR}/${PLATFORM}"
	mkdir -p "${OUTDIR}"

	# NOTE: Using musl on Linux because those binaries are statically linked. This
	# prevents glibc issues.
	download_starship "${TRIPLE}" "${OUTDIR}"
	download_zellij "${TRIPLE}" "${OUTDIR}"
	download_bat "${TRIPLE}" "${OUTDIR}" "${BAT_SHA256}"
	download_jj "${TRIPLE}" "${OUTDIR}" "${JJ_SHA256}"
	download_jq "${JQ_NAME}" "${OUTDIR}"
	download_crit "${CRIT_NAME}" "${OUTDIR}"
	download_rtk "${RTK_NAME}" "${OUTDIR}"
	download_tuicr "${TRIPLE}" "${OUTDIR}" "${TUICR_SHA256}"
}

# macOS reports arm64 where Linux reports aarch64. The directory layout follows `uname` on
# each so that .shellrc-common can build its PATH entry from it directly.
function host_platform() {
	local PLATFORM
	PLATFORM="$(uname -s)/$(uname -m)"
	case "${PLATFORM}" in
		Linux/aarch64|Linux/x86_64|Darwin/arm64|Darwin/x86_64)
			echo "${PLATFORM}"
			;;
		*)
			echo "unsupported platform ${PLATFORM}" >&2
			exit 1
			;;
	esac
}

function download_starship() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local TARBALL="starship-${PLATFORM}.tar.gz"
	curl -fL --output "${TARBALL}" "${STARSHIP_BASE_URL}/${TARBALL}"
	curl -fL --output "${TARBALL}.sha256" "${STARSHIP_BASE_URL}/${TARBALL}.sha256"
	verify "${TARBALL}" "$(cut -d' ' -f1 "${TARBALL}.sha256")"
	tar --directory "${OUTDIR}" -xf "${TARBALL}"
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

# bat publishes no checksum assets at all; the digests passed in above are pinned
# from the sha256 digests in the GitHub release asset metadata. The tarball nests
# everything in a directory, so extract just the binary.
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
# covering all of them.
function download_jq() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local BINARY="jq-${PLATFORM}"
	curl -fL --output jq-sha256sum.txt "${JQ_BASE_URL}/sha256sum.txt"
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
	curl -fL --output checksums.txt "${CRIT_BASE_URL}/checksums.txt"
	curl -fL --output "${BINARY}" "${CRIT_BASE_URL}/${BINARY}"
	verify "${BINARY}" "$(grep " ${BINARY}\$" checksums.txt | cut -d' ' -f1)"
	install -m 755 "${BINARY}" "${OUTDIR}/crit"
}

# rtk publishes a checksums.txt file covering all platforms. Its Linux aarch64
# build is glibc rather than musl (no musl build exists for that arch), so its
# name doesn't follow the shared TRIPLE the way jj's and bat's do.
function download_rtk() {
	local PLATFORM="$1"
	local OUTDIR="$2"
	local TARBALL="rtk-${PLATFORM}.tar.gz"
	curl -fL --output rtk-checksums.txt "${RTK_BASE_URL}/checksums.txt"
	curl -fL --output "${TARBALL}" "${RTK_BASE_URL}/${TARBALL}"
	verify "${TARBALL}" "$(grep " ${TARBALL}\$" rtk-checksums.txt | cut -d' ' -f1)"
	tar --directory "${OUTDIR}" -xf "${TARBALL}" rtk
}

# tuicr publishes no checksum assets, so its release asset metadata digests are
# pinned above. Each tarball contains only the binary at its root.
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
	install -m "${MODE}" "${DOWNLOAD}" "${BINARIES_DIR}/../tuicr-skill/${FILE}"
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

BINARIES_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" == "--all" ]]; then
	PLATFORMS=(Linux/aarch64 Linux/x86_64 Darwin/arm64 Darwin/x86_64)
else
	PLATFORMS=("$(host_platform)")
fi

# Downloads and unpacked intermediates land in a scratch directory so that a failed or
# interrupted run leaves nothing behind in the repo.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}"' EXIT
cd "${SCRATCH}"

for PLATFORM in "${PLATFORMS[@]}"; do
	download_platform "${PLATFORM}"
done

# The tuicr Claude skill is plain text and platform independent, so it is fetched once and
# stays checked in.
mkdir -p "${BINARIES_DIR}/../tuicr-skill"
download_tuicr_skill SKILL.md 644 c97f2b6cc17549536de167ef0bd9dad17ee8be10f8213dd567523f593418fcda
download_tuicr_skill tuicr-wrapper.sh 755 a8ff39f3967a4109de9221849cff82ba80e38a74d636086d8f1d87e45aff5efc
download_tuicr_skill tuicr-wrapper-zellij.sh 755 e442e97902abaa4924ab295707de455a15371f0d72e89c1b76f0563bbf43125a
