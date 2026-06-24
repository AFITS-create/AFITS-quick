importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCapaqV5kvZGVL02mu9wpSGX6HU41Yz_Fo",
  authDomain: "afits-quick-d05b9.firebaseapp.com",
  projectId: "afits-quick-d05b9",
  storageBucket: "afits-quick-d05b9.firebasestorage.app",
  messagingSenderId: "797782746006",
  appId: "1:797782746006:web:219e0ff9e5c34bc8cd73b7"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  console.info("[FCM SW] Background message", payload);
  const notification = payload.notification || {};
  const data = payload.data || {};
  const title = notification.title || data.title || "AFITS Quick";
  const body = notification.body || data.body || "";
  self.registration.showNotification(title, {
    body,
    icon: data.icon || "/icons/icon-192x192.png",
    badge: "/icons/notification-icon.png",
    data: {
      ...data,
      url: data.click_action || "https://afits-quick.vercel.app/"
    }
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "https://afits-quick.vercel.app/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
