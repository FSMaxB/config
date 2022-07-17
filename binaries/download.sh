#!/usr/bin/env bash

set -euxo pipefail

STARSHIP_VERSION="1.9.1"

function download() {
	local PLATFORM="$1"
	curl -L --output "starship-${PLATFORM}.tar.gz" "https://github.com/starship/starship/releases/download/v${STARSHIP_VERSION}/starship-${PLATFORM}.tar.gz"
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
