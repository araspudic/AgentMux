#!/usr/bin/env bash
# Builds AgentMux for Linux into ./dist (.deb + AppImage).
# Needs: Node.js 18+, npm, and build tools for node-pty:  sudo apt install -y nodejs npm build-essential python3
# The Linux UI lives in ./wwwroot (separate from the Windows app's ../wwwroot).
set -euo pipefail
cd "$(dirname "$0")"

npm install
# compile node-pty against Electron's headers
npx electron-builder install-app-deps
npx electron-builder --linux deb AppImage

ls -la dist/*.deb dist/*.AppImage
