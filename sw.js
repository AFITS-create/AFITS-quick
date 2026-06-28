// AFITS Quick — Service Worker
// Provides offline caching for a faster, app-like experience

const CACHE_NAME = 'afits-quick-v49';

try {
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: 'AIzaSyCapaqV5kvZGVL02mu9wpSGX6HU41Yz_Fo',
    authDomain: 'afits-quick-d05b9.firebaseapp.com',
    projectId: 'afits-quick-d05b9',
    storageBucket: 'afits-quick-d05b9.firebasestorage.app',
    messagingSenderId: '797782746006',
    appId: '1:797782746006:web:219e0ff9e5c34bc8cd73b7'
  });
  firebase.messaging().onBackgroundMessage(payload => {
    console.info('[FCM SW] Background message', payload);
    const notification = payload.notification || {};
    const data = payload.data || {};
    const title = notification.title || data.title || 'AFITS Quick';
    const body = notification.body || data.body || '';
    self.registration.showNotification(title, {
      body,
      icon: data.icon || '/icons/icon-192x192.png',
      badge: '/icons/notification-icon.png',
      data: {
        ...data,
        url: data.click_action || 'https://afits-quick.vercel.app/'
      }
    });
  });
} catch (error) {
  // Push support is optional; the app shell should still cache if FCM is unavailable.
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || 'https://afits-quick.vercel.app/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// Files to pre-cache on install
const PRE_CACHE = [
  './',
  './manifest.json',
  './icons/afits-icon.png',
  './icons/favicon-32x32.png',
  './icons/favicon-48x48.png',
  './icons/notification-icon.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

// ── INSTALL: cache shell files ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.allSettled(PRE_CACHE.map(url => cache.add(url))))
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean up old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH: network-first for API calls, cache-first for assets ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin API requests (Firebase, Google Maps, etc.)
  if (request.method !== 'GET') return;
  const isImageRequest = request.destination === 'image' || /\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(url.pathname);
  if (isImageRequest) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          const fresh = fetch(request).then(response => {
            if (response && (response.ok || response.type === 'opaque')) {
              cache.put(request, response.clone()).catch(() => { });
            }
            return response;
          }).catch(() => cached);
          return cached || fresh;
        })
      )
    );
    return;
  }
  if (url.origin === self.location.origin && url.pathname.endsWith('/config.js')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (url.origin === self.location.origin && (request.mode === 'navigate' || request.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html'))) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(response => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('cashfree.com')
  ) return;

  // Cache-first strategy for same-origin and font resources
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request)
        .then(response => {
          // Only cache successful responses
          if (!response || response.status !== 200 || response.type === 'opaque') {
            return response;
          }
          const toCache = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, toCache));
          return response;
        })
        .catch(() => {
          // Fallback: serve index.html for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});




