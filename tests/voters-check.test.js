import test from 'node:test';
import assert from 'node:assert/strict';
import { callsOf, summarize, show, rowsOf, fitWeights, holdout, showHoldout } from '../server/voters_check.mjs';
import { analyze } from '../app/js/signals.js';

function chart(n = 400, seed = 5) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const candles = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = Math.max(5, p * (1 + 0.02 * r() + 0.01 * Math.sin(i / 9)));
    candles.push({ time: 86400 * (20000 + i), open, high: Math.max(open, p) * (1 + Math.abs(r()) * 0.01), low: Math.min(open, p) * (1 - Math.abs(r()) * 0.01), close: p, volume: 1e6 * (1 + r()) });
  }
  return analyze(candles);
}

test('calls are graded like the scoreboard and fresh marks the start of a run', () => {
  const S = chart();
  const { calls, base } = callsOf(S, { stopAtr: 2, takeAtr: 3 });
  assert.ok(base.length > 200);
  assert.ok(calls.some(c => c.id === 'rsi') && calls.some(c => c.id.startsWith('g:')));
  for (const c of calls) assert.ok(c.right === 0 || c.right === 1);
  const sma = calls.filter(c => c.id === 'sma200');
  assert.ok(sma.filter(c => c.fresh).length < sma.length / 3, 'a standing vote counts fresh once per run');
  const s = summarize({ calls, base });
  assert.ok(s.rates.up.all >= 0 && s.rates.up.all <= 1);
  assert.match(show('Test', s), /\[Trend\]/);
});

test('a rule that always loses shows as flipped', () => {
  const base = [], calls = [];
  for (let t = 0; t < 400; t++) {
    base.push({ t, bottom: t % 2, top: 1 - (t % 2) });
    calls.push({ id: 'bad', side: t % 2 ? 'down' : 'up', t, right: 0, fresh: true });
  }
  assert.equal(summarize({ calls, base }).rows.bad.flipped, true);
});

test('weights keep only voters that beat chance, and the holdout grades the newer half', () => {
  const rows = (good) => ({ up: { n: 200, edge: good }, down: { n: 200, edge: good } });
  const w = fitWeights({ rows: { a: rows(0.05), b: rows(-0.02), 'g:trend': rows(0.1), score: rows(0.1) } }, 'edge');
  assert.deepEqual(w, { a: 5, b: 0 });
  const charts = [chart(500, 7), chart(500, 11)].map(S => rowsOf(S, { stopAtr: 2, takeAtr: 3 }, 'crypto'));
  const h = holdout(charts);
  assert.ok(h.grades.equal[40] && h.grades.winners[20]);
  const newer = charts.flat().filter(x => x.t >= h.mid).length;
  assert.ok(newer > 0 && h.grades.equal[20].up + h.grades.equal[20].down <= newer);
  assert.match(showHoldout('Test', h), /winners/);
});
