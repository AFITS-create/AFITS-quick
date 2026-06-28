// AFITS Quick - App Configuration
// Firebase browser config is public by design. Keep secrets, admin passwords,
// and payment credentials only in Firebase/Cloud Functions environment config.

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCapaqV5kvZGVL02mu9wpSGX6HU41Yz_Fo",
  authDomain: "afits-quick-d05b9.firebaseapp.com",
  projectId: "afits-quick-d05b9",
  storageBucket: "afits-quick-d05b9.firebasestorage.app",
  messagingSenderId: "797782746006",
  appId: "1:797782746006:web:219e0ff9e5c34bc8cd73b7"
};

window.APP_CONFIG = {
  cashfreeMode: "PROD",
  cashfreeCreateOrderUrl: "https://us-central1-afits-quick-d05b9.cloudfunctions.net/createCashfreeOrder",
  cashfreeVerifyOrderUrl: "https://us-central1-afits-quick-d05b9.cloudfunctions.net/verifyCashfreeOrder",
  fcmVapidKey: "BLOQIb8h6FQOM7Xzz7xIJKTiMDr3bKeKXpAXem4lqr6ZlBE-gRQLUsmv-mQcUyI-qzNTchG4_Um1n0IvyUmZ610",
  pushNotificationUrl: "https://us-central1-afits-quick-d05b9.cloudfunctions.net/sendPushNotification",
  afitsAiChatUrl: "/api/afits-ai",
  afitsAiClearCacheUrl: "/api/clear-afits-ai-cache"
};
