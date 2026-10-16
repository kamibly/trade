// A small fetch that sends its requests through a proxy, for STOCK_PROXY: the
// stock data hosts (Yahoo, Nasdaq) see the proxy's address, say a home
// connection through a Tailscale exit node, instead of the cloud VM's, which
// they limit far more. Everything else still goes out directly.
//
// Proxies: http://host:port (HTTP CONNECT, optional user:pass) and
// socks5://host:port (no password). No packages needed.

import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

function readUntil(socket, done) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      const n = done(buf);
      if (n) {
        socket.off('data', onData);
        socket.off('error', reject);
        socket.pause();
        if (buf.length > n) socket.unshift(buf.subarray(n));
        resolve(buf.subarray(0, n));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.resume(); // an earlier read paused it
  });
}

function open(proxy) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(proxy.port) || (proxy.protocol === 'socks5:' ? 1080 : 8080), proxy.hostname, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(15000, () => s.destroy(new Error('The stock proxy did not answer in 15 seconds')));
  });
}

async function httpConnect(proxy, host, port) {
  const s = await open(proxy);
  const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : '';
  s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = (await readUntil(s, b => { const i = b.indexOf('\r\n\r\n'); return i < 0 ? 0 : i + 4; })).toString();
  const status = Number(head.split(' ')[1]);
  if (status !== 200) {
    s.destroy();
    throw new Error(`The stock proxy answered ${status || head.split('\r\n')[0]}`);
  }
  return s;
}

async function socks5Connect(proxy, host, port) {
  const s = await open(proxy);
  s.write(Buffer.from([5, 1, 0]));
  const hello = await readUntil(s, b => (b.length >= 2 ? 2 : 0));
  if (hello[0] !== 5 || hello[1] !== 0) throw new Error('The stock proxy wants a SOCKS password, which is not supported');
  const name = Buffer.from(host);
  s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
  // Reply: VER REP RSV ATYP ADDR PORT, where ADDR's length depends on ATYP.
  const reply = await readUntil(s, b => {
    if (b.length < 5) return 0;
    const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : 1 + b[4];
    return b.length >= 4 + len + 2 ? 4 + len + 2 : 0;
  });
  if (reply[1] !== 0) {
    s.destroy();
    throw new Error(`The stock proxy could not reach ${host} (SOCKS error ${reply[1]})`);
  }
  return s;
}

export function proxiedFetch(proxyUrl, { tlsOptions = {} } = {}) {
  // "ts-proxy:1056" without a scheme means an HTTP proxy.
  const proxy = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
  const connect = proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:' ? socks5Connect : httpConnect;
  return async (url, { headers = {}, signal } = {}) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('The stock proxy is only used for https');
    const port = Number(u.port) || 443;
    const raw = await connect(proxy, u.hostname, port);
    const socket = tls.connect({ socket: raw, servername: u.hostname, ...tlsOptions });
    return new Promise((resolve, reject) => {
      const req = https.request({ host: u.hostname, port, path: u.pathname + u.search, method: 'GET', headers: { ...headers, Connection: 'close' }, createConnection: () => socket, signal }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const one of [].concat(v)) h.append(k, one);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: h, text: async () => body, json: async () => JSON.parse(body) });
        });
      });
      req.on('error', e => { socket.destroy(); reject(e); });
      req.end();
    });
  };
}
