import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxiedFetch, fallbackFetch } from '../server/proxy.mjs';

function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
}

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('stock requests go through an HTTP or SOCKS5 proxy', async t => {
  let tlsOpts;
  try { tlsOpts = selfSigned(); } catch { t.skip('openssl is not installed'); return; }
  const seen = [];
  const site = https.createServer(tlsOpts, (req, res) => {
    seen.push(req.url);
    res.setHeader('Set-Cookie', ['A3=x; Path=/', 'B=y']);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const sitePort = await listen(site);
  const hosts = [];

  const http = net.createServer(c => c.once('data', d => {
    const [, target] = d.toString().split(' ');
    hosts.push(target);
    const out = net.connect(sitePort, '127.0.0.1', () => { c.write('HTTP/1.1 200 Connection established\r\n\r\n'); c.pipe(out).pipe(c); });
  }));
  const socks = net.createServer(c => c.once('data', () => {
    c.write(Buffer.from([5, 0]));
    c.once('data', d => {
      hosts.push(`${d.subarray(5, 5 + d[4]).toString()}:${d.readUInt16BE(5 + d[4])}`);
      const out = net.connect(sitePort, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); c.pipe(out).pipe(c); });
    });
  }));
  const httpPort = await listen(http);
  const socksPort = await listen(socks);
  const tlsOptions = { rejectUnauthorized: false };
  try {
    for (const p of [`127.0.0.1:${httpPort}`, `socks5://127.0.0.1:${socksPort}`]) {
      const res = await proxiedFetch(p, { tlsOptions })(`https://localhost:${sitePort}/v8/chart/AAPL?x=1`, { headers: { 'User-Agent': 'test' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      assert.deepEqual(res.headers.getSetCookie(), ['A3=x; Path=/', 'B=y']);
    }
    assert.deepEqual(hosts, [`localhost:${sitePort}`, `localhost:${sitePort}`]);
    assert.deepEqual(seen, ['/v8/chart/AAPL?x=1', '/v8/chart/AAPL?x=1']);
  } finally {
    site.close(); http.close(); socks.close();
  }
});

test('the proxy is a fallback: used after a refusal, for a while, by every run', async () => {
  let t = 0;
  let until = 0;
  const store = { get: async () => until, set: async v => { until = v; } };
  const calls = [];
  let directStatus = 200;
  const direct = async url => { calls.push(['vm', url]); return { status: directStatus }; };
  const proxied = async url => { calls.push(['home', url]); return { status: 200 }; };
  const f = fallbackFetch(direct, proxied, { stickyMs: 1000, now: () => t, store });
  await f('a');
  directStatus = 429;
  await f('b');
  await f('c'); // still within the 30 minutes (here 1 s): straight to the proxy
  t = 2000;
  directStatus = 200;
  await f('d'); // the VM is asked again
  assert.deepEqual(calls, [['vm', 'a'], ['vm', 'b'], ['home', 'b'], ['home', 'c'], ['vm', 'd']]);
  const down = fallbackFetch(async () => { throw new TypeError('fetch failed'); }, proxied, { now: () => t, store });
  assert.equal((await down('e')).status, 200);
});
