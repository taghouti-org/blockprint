#!/usr/bin/env bash
# Downloads the in-browser Minecraft client (zardoy/minecraft-web-client, MIT) into app/vendor/mwc.
set -euo pipefail
VERSION="${1:-v3.1.0}"
cd "$(dirname "$0")/.."
mkdir -p vendor/mwc
curl -fsSL -o vendor/self-host.zip "https://github.com/zardoy/minecraft-web-client/releases/download/${VERSION}/self-host.zip"
unzip -q -o vendor/self-host.zip -d vendor/mwc
rm vendor/self-host.zip
echo "minecraft-web-client ${VERSION} installed in app/vendor/mwc"
