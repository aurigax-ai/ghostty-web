#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(tr -d '[:space:]' < "$root/GHOSTTY_COMMIT")"
src="$root/vendor/ghostty"
if [ ! -d "$src/.git" ]; then
  git clone --filter=blob:none https://github.com/ghostty-org/ghostty.git "$src"
fi
git -C "$src" fetch --quiet origin "$commit"
git -C "$src" checkout --quiet --detach "$commit"
(cd "$src" && zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall)
cp "$src/zig-out/bin/ghostty-vt.wasm" "$root/ghostty-vt.wasm"
echo "built ghostty-vt.wasm from ghostty $commit"
