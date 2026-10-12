#!/bin/sh
# Inside the build container: copies the repo from /src (read-only), builds the canvas, bundles the server
# with Node for Linux, builds the app, and puts the .deb, the AppImage and Cargo.lock in /out.
set -eu
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude dist \
  --exclude packages/desktop/src-tauri/target --exclude packages/desktop/src-tauri/resources \
  --exclude packages/desktop/src-tauri/binaries --exclude packages/desktop/src-tauri/gen \
  /src/ /build/
cd /build
npm ci --no-audit --no-fund
npm run build -w @huddle/web
cd packages/desktop
HUDDLE_NODE_TARGET=x86_64-unknown-linux-gnu node scripts/bundle.mjs
npx tauri build "$@"
mkdir -p /out
cp src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage /out/
cp src-tauri/Cargo.lock /out/
ls -la /out
