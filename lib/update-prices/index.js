// Update-prices orchestrator.
//
// Auto-detects which schema is present in the target index.html and
// runs the appropriate updater. If the HTML doesn't contain inline
// data, falls back to looking for an adjacent <name>_data.json file.

const fs = require('fs');
const path = require('path');
const { runAiSchema } = require('./ai-schema');
const { runSoftwareSchemaInline, runSoftwareSchemaExternal } = require('./sw-schema');

async function runUpdatePrices({ indexPath, dryRun = false }) {
  if (!fs.existsSync(indexPath)) {
    console.error(`File not found: ${indexPath}`);
    process.exit(1);
  }

  const src = fs.readFileSync(indexPath, 'utf8');
  let updated = null;
  let externalJsonUpdated = false;

  if (/^const TICKER_DATA = \{/m.test(src)) {
    updated = await runAiSchema(src);
  } else if (/^var SW_DATA = \{/m.test(src)) {
    updated = await runSoftwareSchemaInline(src);
  } else {
    // Look for an external data file in the same directory.
    const dir = path.dirname(indexPath);
    const candidates = ['sw_data.json', 'semi_data.json', 'ai_data.json'].map((f) => path.join(dir, f));
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) {
      console.log(`Found external data file: ${found}`);
      if (dryRun) {
        console.log('Dry run — would update ' + found);
        return;
      }
      externalJsonUpdated = await runSoftwareSchemaExternal(found);
      if (!externalJsonUpdated) process.exit(1);
      return;
    }
    console.error(
      'Unknown schema — expected `const TICKER_DATA = {` or `var SW_DATA = {` in HTML, ' +
      `or one of ${candidates.map(c => path.basename(c)).join(', ')} in the same directory.`
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log('Dry run — not writing file.');
    return;
  }
  if (!updated) {
    console.error('No updates — leaving file unchanged.');
    process.exit(1);
  }
  fs.writeFileSync(indexPath, updated);
  console.log(`Wrote ${indexPath}`);
}

module.exports = { runUpdatePrices };
