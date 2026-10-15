// Phone notifications while the app is open or in the background. Alerts when
// the app is fully closed come from the OCI server in stage 4.

// Quiet hours wrap past midnight: 22 to 7 means 22:00 to 06:59.
export function inQuietHours(date, start = 22, end = 7) {
  const h = date.getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}

export const canNotify = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';

export async function askPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

export async function notify(title, body, hash) {
  if (!canNotify()) return false;
  const options = { body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: hash, data: { hash } };
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, options);
  } catch {
    new Notification(title, options); // eslint-disable-line no-new
  }
  return true;
}
