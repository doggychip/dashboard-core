#!/usr/bin/env node
//
// CLI entry point for `update-prices`.
//
//   $ npx update-prices ./public/index.html [--dry-run]
//
// Auto-detects schema (TICKER_DATA inline vs SW_DATA blob) and refreshes
// live fields from Yahoo Finance. Editorial fields are never touched.

const path = require('path');
const { runUpdatePrices } = require('../lib/update-prices');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(a => !a.startsWith('--'));
  const target = positional[0];

  if (!target) {
    console.error('Usage: update-prices <path-to-index.html> [--dry-run]');
    process.exit(1);
  }

  const indexPath = path.resolve(target);
  await runUpdatePrices({ indexPath, dryRun });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
