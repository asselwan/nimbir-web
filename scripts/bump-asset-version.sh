#!/bin/sh
# Stamp the asset-fingerprint version into the two files that reference the
# fingerprinted assets (prm_28626d25 v49 follow-up).
#
#   index.html -> surface.css?v=VER  and  import('./app.js?v=VER)
#   app.js     -> import ... from './gods-eye.js?v=VER'
#
# The Dockerfile cannot inject the commit hash at build time (.git/ is excluded
# by .dockerignore and nginx:alpine has no git), so the value is stamped here
# and must be re-stamped before every release commit - that is what makes each
# deploy change the asset URLs.
#
# Usage:  scripts/bump-asset-version.sh [version]
# Default version: the short git hash of HEAD (the commit being superseded).
set -e
cd "$(dirname "$0")/.."

V="${1:-$(git rev-parse --short HEAD)}"
case "$V" in
  *[!A-Za-z0-9._-]*)
    echo "bump-asset-version: refusing unsafe version '$V'" >&2
    exit 1
    ;;
esac

for f in index.html app.js; do
  sed -i -E "s/([?&]v=)[A-Za-z0-9._-]+/\\1${V}/g" "$f"
done

echo "bump-asset-version: stamped ?v=${V}"
grep -n -o '[?&]v=[A-Za-z0-9._-]*' index.html app.js | sort -u
