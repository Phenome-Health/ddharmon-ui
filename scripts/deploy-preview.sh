#!/usr/bin/env bash
# Rebuild the static (backend-less) preview bundle and deploy it to the linked
# Netlify site (ddharmon.netlify.app). Same URL updates in ~30s.
#
# One-time setup (per machine):
#   npx --yes netlify-cli login              # browser auth
#   npx --yes netlify-cli link --name ddharmon   # attaches this repo to the site
#
# Then to publish the current working tree:
#   ./scripts/deploy-preview.sh
#
# Note: this is a Node-only build (VITE_STATIC bakes the committed fixtures in
# frontend/public/static-data/). To refresh those seeded sample runs first, run
# `python scripts/build_static_fixtures.py` before deploying.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"

echo ">>> building static preview (VITE_STATIC=1)"
VITE_STATIC=1 npm run build
cp dist/index.html dist/404.html
printf '/*    /index.html   200\n' > dist/_redirects

cd "$ROOT"
echo ">>> deploying to Netlify (prod)"
npx --yes netlify-cli deploy --prod --dir=frontend/dist
