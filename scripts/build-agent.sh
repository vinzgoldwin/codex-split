#!/bin/sh
set -eu

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
output_dir="${project_dir}/public/downloads"
collector_version="${COLLECTOR_VERSION:-0.2.0}"

mkdir -p "$output_dir"


checksum() {
    checksum_dir="$(dirname -- "$1")"
    checksum_file="$(basename -- "$1")"
    if command -v sha256sum >/dev/null 2>&1; then
        (cd "$checksum_dir" && sha256sum "$checksum_file" > "$checksum_file.sha256")
    else
        (cd "$checksum_dir" && shasum -a 256 "$checksum_file" > "$checksum_file.sha256")
    fi
}

build() {
    target_os="$1"
    go_arch="$2"
    asset_arch="$3"
    extension="$4"
    asset="codex-split-${target_os}-${asset_arch}-${collector_version}${extension}"
    [ "$target_os" = "macos" ] && target_os="darwin"

    echo "Building ${asset}"
    (cd "${project_dir}/agent" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$go_arch" \
        go build -trimpath -ldflags "-s -w -X main.version=${collector_version}" -o "${output_dir}/${asset}" .)
    checksum "${output_dir}/${asset}"
}

build linux amd64 x86_64 ''
build linux arm64 aarch64 ''
build macos amd64 x86_64 ''
build macos arm64 aarch64 ''
build windows amd64 x86_64 .exe
build windows arm64 aarch64 .exe

node --input-type=module - "$output_dir" "$collector_version" <<'NODE'
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [directory, version] = process.argv.slice(2);
const assets = {};
for (const [os, platform] of [['linux','linux'],['darwin','macos'],['windows','windows']]) {
  for (const [arch, label] of [['amd64','x86_64'],['arm64','aarch64']]) {
    const file = `codex-split-${platform}-${label}-${version}${os === 'windows' ? '.exe' : ''}`;
    assets[`${os}/${arch}`] = {file, sha256:createHash('sha256').update(readFileSync(`${directory}/${file}`)).digest('hex')};
  }
}
writeFileSync(`${directory}/latest.json`, JSON.stringify({version,assets},null,2)+'\n');
NODE
