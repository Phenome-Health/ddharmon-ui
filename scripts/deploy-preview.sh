#!/usr/bin/env bash
# Rebuild the static (backend-less) preview bundle and deploy it to the linked
# Netlify site (ddharmon.netlify.app). Same URL updates in ~30s.
#
# One-time setup (per machine):
#   npx --yes netlify-cli login              # browser auth
#   npx --yes netlify-cli link --name ddharmon   # attaches this repo to the site
#
# Usage:
#   ./scripts/deploy-preview.sh              # typecheck -> build -> deploy to PROD (team's live URL)
#   ./scripts/deploy-preview.sh --draft      # ...deploy to a throwaway DRAFT url (prod link untouched)
#   ./scripts/deploy-preview.sh --skip-typecheck   # skip the tsc gate (not recommended)
#
# Safety: the typecheck (tsc) + build (vite/esbuild) both run BEFORE any upload,
# and `set -e` aborts on the first failure — so a type error or a JSX syntax
# error (e.g. a raw `>` in prose) stops the deploy; prod never gets a broken bundle.
#
# Note: this is a Node-only build (VITE_STATIC bakes the committed fixtures in
# frontend/public/static-data/). To refresh those seeded sample runs first, run
# `python scripts/build_static_fixtures.py` before deploying.
set -euo pipefail

DRAFT=0
SKIP_TYPECHECK=0
for arg in "$@"; do
  case "$arg" in
    --draft) DRAFT=1 ;;
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"

if [[ "$SKIP_TYPECHECK" -eq 1 ]]; then
  echo ">>> SKIPPING typecheck (--skip-typecheck)"
else
  echo ">>> typecheck (tsc --noEmit)"
  npm run typecheck
fi

echo ">>> building static preview (VITE_STATIC=1)"
VITE_STATIC=1 npm run build
cp dist/index.html dist/404.html
printf '/*    /index.html   200\n' > dist/_redirects

cd "$ROOT"
if [[ "$DRAFT" -eq 1 ]]; then
  echo ">>> deploying to Netlify (DRAFT — prod link untouched)"
  npx --yes netlify-cli deploy --dir=frontend/dist
else
  echo ">>> deploying to Netlify (PROD)"
  npx --yes netlify-cli deploy --prod --dir=frontend/dist
fi
