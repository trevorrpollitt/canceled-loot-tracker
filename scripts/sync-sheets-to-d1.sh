#!/usr/bin/env bash
set -e

echo "==> Generating migration SQL from Sheets…"
node --env-file=.env scripts/migrate-sheets-to-d1.js

echo ""
echo "==> Applying to local D1…"
node scripts/apply-migration.js

echo ""
echo "Done."
