// Copies the app modules the server's engine uses into server/js, so the
// server folder works on its own (only that folder goes to the OCI VM).
// Run after changing any of them:  npm run sync-server
// tests/server-engine.test.js fails if a copy is out of date.

import { copyFile } from 'node:fs/promises';

export const SHARED = ['backtest', 'candles', 'data', 'fees', 'filter', 'forecast', 'format', 'indicators', 'limiter', 'ml', 'paper', 'portfolio', 'scanner', 'setups', 'signals'];

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const name of SHARED) await copyFile(new URL(`../app/js/${name}.js`, import.meta.url), new URL(`../server/js/${name}.js`, import.meta.url));
  console.log(`Copied ${SHARED.length} modules to server/js`);
}
