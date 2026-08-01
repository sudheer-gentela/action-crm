// serviceWorkerRegistration.js
//
// Registers public/service-worker.js and provides the push-subscription
// helpers used by the notification settings toggle.
//
// Registration is deliberately conservative:
//   - only in production builds, so `npm start` is never served from a cache
//   - only over HTTPS or localhost, which the SW spec requires anyway
//   - after the load event, so it never competes with first paint
//
// If a service worker ever misbehaves in the field, unregister() below plus a
// hard reload clears it. Worth knowing before you deploy this the first time:
// a bad service worker is the one bug users cannot fix by refreshing.

const API = process.env.REACT_APP_API_URL || '';

const isLocalhost = Boolean(
  typeof window !== 'undefined' && (
    window.location.hostname === 'localhost'
    || window.location.hostname === '[::1]'
    || /^127(\.\d{1,3}){3}$/.test(window.location.hostname)
  )
);

export function register() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (process.env.NODE_ENV !== 'production') return;
  if (window.location.protocol !== 'https:' && !isLocalhost) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${process.env.PUBLIC_URL || ''}/service-worker.js`)
      .catch((err) => console.warn('[sw] registration failed:', err.message));
  });
}

export function unregister() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.unregister())
    .catch(() => {});
}

/* ── Push subscription ──────────────────────────────────────────────────── */

export function pushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

// iOS delivers web push only to a PWA launched from the home screen, never to
// the app running in a Safari tab. Callers use this to explain why the toggle
// is unavailable instead of letting the user tap something that cannot work.
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

export function isIos() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function permission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = window.atob(base64);
  const out     = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function authHeaders() {
  const token = localStorage.getItem('token') || localStorage.getItem('authToken');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/**
 * Ask for permission, subscribe, and register the subscription with the
 * backend. Must be called from a user gesture — browsers reject a permission
 * prompt that is not tied to a click.
 *
 * Resolves { ok: true } or { ok: false, reason } — never throws, so the caller
 * can render the reason directly.
 */
export async function subscribeToPush() {
  if (!pushSupported())            return { ok: false, reason: 'This browser does not support push notifications.' };
  if (isIos() && !isStandalone())  return { ok: false, reason: 'On iPhone and iPad, add GoWarm to your home screen first — Safari only delivers notifications to an installed app.' };

  const result = await Notification.requestPermission();
  if (result === 'denied')  return { ok: false, reason: 'Notifications are blocked for this site. You can re-enable them in your browser settings.' };
  if (result !== 'granted') return { ok: false, reason: 'Notification permission was not granted.' };

  try {
    const keyRes = await fetch(`${API}/api/push/vapid-key`, { headers: authHeaders() });
    if (!keyRes.ok) return { ok: false, reason: 'Push is not configured on the server yet.' };
    const { publicKey } = await keyRes.json();
    if (!publicKey)   return { ok: false, reason: 'Push is not configured on the server yet.' };

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const res = await fetch(`${API}/api/push/subscribe`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
    });
    if (!res.ok) return { ok: false, reason: 'Could not save the subscription. Try again.' };

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message || 'Could not enable notifications.' };
  }
}

export async function unsubscribeFromPush() {
  if (!pushSupported()) return { ok: true };
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { ok: true };

    await fetch(`${API}/api/push/subscribe`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});

    await sub.unsubscribe();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function isSubscribed() {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}
