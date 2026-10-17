// Talks to your own trade-service on the OCI server: it sends alerts while the
// app is closed, scans the S&P 500 and every actively traded coin, and keeps the watchlist
// and holdings in sync between phones. Every call carries the server key.

export class ServerError extends Error {}

// Settings that travel with the watchlist and holdings.
export const SYNCED_SETTINGS = ['alertTf', 'tune', 'mode', 'buyAt', 'sellAt', 'stopAtr', 'takeAtr', 'quietHours', 'riskPct', 'paperStart', 'tradeFilter', 'setups'];

export function cleanUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new ServerError('That does not look like a web address.');
  }
}

export async function serverFetch(settings, path, { method = 'GET', body, timeout = 15000 } = {}) {
  if (!settings.serverUrl || !settings.serverKey) throw new ServerError('Add your server address and key in Settings.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(`${settings.serverUrl}${path}`, {
      method,
      signal: ctrl.signal,
      headers: { 'X-API-Key': settings.serverKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ServerError(e.name === 'AbortError' ? 'Your server took too long to answer.' : 'Could not reach your server. Check the address, and that it is running.');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ServerError((json && json.detail) || `Your server answered ${res.status}.`);
  return json;
}

// What the phone sends: watchlist, holdings and the synced settings.
export function buildProfile({ watchlist, holdings, settings, changedAt }) {
  return {
    watchlist: watchlist.map(({ type, symbol, name, geckoId }) => ({ type, symbol, name, ...(geckoId ? { geckoId } : {}) })),
    holdings,
    settings: Object.fromEntries(SYNCED_SETTINGS.map(k => [k, settings[k]])),
    updatedAt: changedAt,
  };
}

// Which side wins: the newer edit. Returns 'pull', 'push' or 'same'.
export function syncDirection(localChangedAt, server) {
  const remote = server && server.updatedAt;
  if (!remote) return 'push';
  if (remote > (localChangedAt || 0)) return 'pull';
  if (remote < (localChangedAt || 0)) return 'push';
  return 'same';
}

// Server holdings replace the phone's, keeping alerts the phone already showed.
export function mergeHoldings(local, remote) {
  const shown = new Map(local.map(h => [h.id, h.alerted || {}]));
  return remote.map(h => ({ ...h, alerted: { ...(h.alerted || {}), ...(shown.get(h.id) || {}) } }));
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

const keyToBase64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Registers this phone for notifications from the server.
export async function subscribePush(settings, publicKey) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new ServerError('This browser cannot get alerts while the app is closed. Install the app from Chrome first.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with different server keys can't be used: renew it.
  if (sub && sub.options && sub.options.applicationServerKey && keyToBase64(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    } catch (e) {
      throw new ServerError(`Chrome could not sign this phone up for alerts (${e.message}). Use the installed app, not an incognito tab.`);
    }
  }
  await serverFetch(settings, '/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: (navigator.userAgentData && navigator.userAgentData.platform) || 'Phone' } });
  return sub.endpoint;
}

export async function unsubscribePush(settings) {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe();
  await serverFetch(settings, '/push/unsubscribe', { method: 'POST', body: { endpoint } }).catch(() => {});
}

// The service worker reads the server address and key from here to send
// your Useful / Not useful ratings straight from a notification.
export const SW_CONFIG_CACHE = 'config-trade';

export async function saveWorkerConfig(settings) {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(SW_CONFIG_CACHE);
    await cache.put('./server-config', new Response(JSON.stringify({ serverUrl: settings.serverUrl || '', serverKey: settings.serverKey || '' }), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* the buttons in the app still work */ }
}

export async function currentEndpoint() {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
  return sub ? sub.endpoint : null;
}
