import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Every app module must be in the offline cache list, or the installed app
// breaks when the site can't be reached (a missing import stops app.js).
test('the service worker caches every app module', () => {
  const sw = readFileSync(new URL('../app/sw.js', import.meta.url), 'utf8');
  for (const f of readdirSync(new URL('../app/js/', import.meta.url)).filter(n => n.endsWith('.js'))) {
    assert.ok(sw.includes(`'./js/${f}'`), `app/sw.js ASSETS is missing ./js/${f}`);
  }
});
