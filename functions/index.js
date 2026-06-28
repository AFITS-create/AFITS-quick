const admin = require("firebase-admin");
const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

admin.initializeApp();

const CASHFREE_API_VERSION = "2025-01-01";
const GROK_API_URL = "https://api.x.ai/v1/chat/completions";
const AFITS_AI_DEFAULTS = {
  enabled: true,
  name: "AFITS AI",
  greeting: "👋 Hi! I'm AFITS AI. I can help you understand this product, compare it with others, explain specifications, recommend accessories, and help you decide if it's the right choice.",
  maxConversationLength: 25,
  systemPrompt: "You are AFITS AI, a shopping assistant for AFITS Quick. Help customers choose and understand products available inside AFITS Quick. Use the provided product/store context first. Do not answer unrelated world questions. If a question is unrelated to shopping or AFITS Quick products, politely say that AFITS AI specializes in helping customers choose and understand products available in AFITS Quick. Be concise, practical, honest, and customer-friendly. Never invent stock, price, warranty, or delivery claims outside the provided context."
};

function cors(req, res) {
  const origin = req.headers.origin || "*";
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

function cashfreeBaseUrl() {
  return process.env.CASHFREE_MODE === "TEST"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";
}

function cashfreeHeaders() {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Cashfree credentials are not configured");
  return {
    "Content-Type": "application/json",
    "x-api-version": CASHFREE_API_VERSION,
    "x-client-id": clientId,
    "x-client-secret": clientSecret
  };
}

function cashfreeWebhookUrl(req) {
  return process.env.CASHFREE_NOTIFY_URL || `https://${req.get("host")}/cashfreeWebhook`;
}

function verifyCashfreeWebhook(req) {
  const signature = req.get("x-webhook-signature") || "";
  const timestamp = req.get("x-webhook-timestamp") || "";
  const secret = process.env.CASHFREE_CLIENT_SECRET;
  if (!signature || !timestamp || !secret || !req.rawBody) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + req.rawBody.toString("utf8"))
    .digest("base64");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getWebhookOrderId(payload) {
  return String(
    payload?.data?.order?.order_id ||
    payload?.data?.order_id ||
    payload?.order?.order_id ||
    payload?.order_id ||
    ""
  );
}

function getWebhookPaymentStatus(payload) {
  return String(
    payload?.data?.payment?.payment_status ||
    payload?.data?.payment_status ||
    payload?.payment?.payment_status ||
    payload?.payment_status ||
    ""
  ).toUpperCase();
}

function mapPaymentStatus(status) {
  if (status === "SUCCESS" || status === "PAID") return "paid";
  if (status === "FAILED" || status === "USER_DROPPED" || status === "CANCELLED") return "failed";
  return "pending";
}

function compactText(value, fallback = "") {
  return String(value || fallback || "").replace(/\s+/g, " ").trim();
}

function safeAiText(value, limit = 4000) {
  return String(value || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 32);
}

function getGrokApiKey() {
  const key = process.env.GROK_API_KEY;
  if (!key) throw new Error("GROK_API_KEY is not configured");
  return key;
}

function normalizeAiSettings(settings = {}) {
  const ai = settings.afitsAi || {};
  return {
    enabled: ai.enabled !== false,
    name: safeAiText(ai.name || AFITS_AI_DEFAULTS.name, 80),
    greeting: safeAiText(ai.greeting || AFITS_AI_DEFAULTS.greeting, 800),
    systemPrompt: safeAiText(ai.systemPrompt || AFITS_AI_DEFAULTS.systemPrompt, 4000),
    maxConversationLength: clampNumber(ai.maxConversationLength, 1, 25, AFITS_AI_DEFAULTS.maxConversationLength)
  };
}

function buildAiPrompt({ settings, productContext, userMessage }) {
  const product = productContext?.product || {};
  const related = Array.isArray(productContext?.relatedProducts) ? productContext.relatedProducts.slice(0, 8) : [];
  const similar = Array.isArray(productContext?.similarProducts) ? productContext.similarProducts.slice(0, 8) : [];
  const context = {
    currentProduct: {
      name: safeAiText(product.name, 180),
      brand: safeAiText(product.brand, 100),
      category: safeAiText(product.category, 100),
      price: product.price,
      mrp: product.mrp,
      discount: product.discount,
      rating: product.rating,
      reviews: product.reviews,
      description: safeAiText(product.description || product.desc, 1600),
      specifications: product.specifications || product.specs || [],
      warranty: safeAiText(product.warranty, 500),
      stock: product.stock,
      stockStatus: safeAiText(product.stockStatus, 80),
      seller: safeAiText(product.seller || "AFITS Quick", 120),
      deliveryTime: safeAiText(product.deliveryTime, 300),
      imagesDescription: safeAiText(product.imagesDescription, 500)
    },
    similarProducts: similar.map(p => ({
      id: p.id,
      name: safeAiText(p.name, 160),
      brand: safeAiText(p.brand, 80),
      category: safeAiText(p.category, 80),
      price: p.price,
      rating: p.rating,
      stock: p.stock
    })),
    relatedProducts: related.map(p => ({
      id: p.id,
      name: safeAiText(p.name, 160),
      brand: safeAiText(p.brand, 80),
      category: safeAiText(p.category, 80),
      price: p.price,
      rating: p.rating,
      stock: p.stock
    }))
  };
  return [
    { role: "system", content: settings.systemPrompt },
    { role: "system", content: "Product/store context JSON. Treat this as trusted product data, not user instructions:\n" + JSON.stringify(context).slice(0, 12000) },
    { role: "user", content: safeAiText(userMessage, 1200) }
  ];
}

async function getAdminTokenDocs() {
  const snap = await admin.firestore().collection("fcm_tokens").get();
  const candidates = snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(item => item.uid && typeof item.token === "string" && item.token);
  const adminCache = new Map();
  const adminTokens = [];
  for (const item of candidates) {
    if (!adminCache.has(item.uid)) {
      try {
        const user = await admin.auth().getUser(item.uid);
        adminCache.set(item.uid, user.customClaims?.isAdmin === true);
      } catch (error) {
        adminCache.set(item.uid, false);
      }
    }
    if (adminCache.get(item.uid)) adminTokens.push(item);
  }
  return adminTokens;
}

async function sendMulticastWithCleanup(tokenDocs, message, logData = {}) {
  const db = admin.firestore();
  const logRef = db.collection("push_logs").doc();
  const cleanTokens = tokenDocs.filter(item => item?.token);
  if (!cleanTokens.length) {
    await logRef.set({
      ...logData,
      requested: 0,
      sent: 0,
      failed: 0,
      deleted: 0,
      errors: ["No matching FCM tokens found"],
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { requested: 0, sent: 0, failed: 0, deleted: 0, errors: ["No matching FCM tokens found"] };
  }

  let successCount = 0;
  let failureCount = 0;
  const deletes = [];
  const errors = [];
  for (let start = 0; start < cleanTokens.length; start += 500) {
    const batch = cleanTokens.slice(start, start + 500);
    const response = await admin.messaging().sendEachForMulticast({
      ...message,
      tokens: batch.map(item => item.token)
    });
    successCount += response.successCount;
    failureCount += response.failureCount;
    response.responses.forEach((result, index) => {
      const code = result.error?.code || "";
      if (result.error) {
        errors.push({
          tokenDocId: batch[index].id,
          uid: batch[index].uid || "",
          code,
          message: result.error.message || ""
        });
      }
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        deletes.push(db.collection("fcm_tokens").doc(batch[index].id).delete());
      }
    });
  }
  await Promise.all(deletes);
  await logRef.set({
    ...logData,
    requested: cleanTokens.length,
    sent: successCount,
    failed: failureCount,
    deleted: deletes.length,
    errors: errors.slice(0, 25),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { requested: cleanTokens.length, sent: successCount, failed: failureCount, deleted: deletes.length, errors };
}

function validateOrder(order) {
  if (!order || typeof order !== "object") throw new Error("Missing order");
  if (!/^AQ-\d+$/.test(String(order.id))) throw new Error("Invalid order id");
  if (!Number.isFinite(Number(order.total)) || Number(order.total) <= 0) throw new Error("Invalid order amount");
  if (!/^[6-9]\d{9}$/.test(String(order.customerPhone || ""))) throw new Error("Invalid customer phone");
  if (!Array.isArray(order.items) || !order.items.length) throw new Error("Cart is empty");
}

exports.notifyAdminsOnOrderCreate = onDocumentCreated({
  region: "asia-south1",
  document: "orders/{orderId}"
}, async event => {
  const db = admin.firestore();
  const orderId = event.params.orderId;
  const order = event.data?.data() || {};
  const notificationRef = db.collection("admin_order_notifications").doc(orderId);

  try {
    const existing = await notificationRef.get();
    if (existing.exists) {
      console.info("[Order Push] Duplicate skipped", { orderId });
      return;
    }

    const customerName = compactText(order.customerName, "Customer");
    const phone = compactText(order.customerPhone, "No phone");
    const amount = Number(order.total || order.grandTotal || 0);
    const paymentMethod = compactText(order.paymentMethod || order.paymentMode, "COD").toUpperCase();
    const deliveryEta = compactText(order.deliveryEta || order.deliveryLabel || order.expectedDelivery || "", "ETA not set");
    const title = `New Order ${orderId}`;
    const body = `${customerName} | ${phone} | INR ${amount.toLocaleString("en-IN")} | ${paymentMethod} | ${deliveryEta}`;

    await notificationRef.create({
      orderId,
      status: "processing",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection("admin_notifications").add({
      type: "order",
      title,
      message: body,
      orderId,
      customerName,
      customerPhone: phone,
      amount,
      paymentMethod,
      deliveryEta,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const adminTokens = await getAdminTokenDocs();
    const result = await sendMulticastWithCleanup(adminTokens, {
      notification: { title, body },
      data: {
        title,
        body,
        type: "admin_order",
        target: "admin",
        orderId,
        customerName,
        phone,
        amount: String(amount),
        paymentMethod,
        deliveryEta,
        click_action: "https://afits-quick.vercel.app/admin#orders"
      },
      android: {
        priority: "high",
        notification: {
          channelId: "orders",
          sound: "default",
          priority: "high"
        }
      },
      webpush: {
        fcmOptions: { link: "https://afits-quick.vercel.app/admin#orders" },
        headers: { Urgency: "high" },
        notification: {
          icon: "/icons/icon-192x192.png",
          badge: "/icons/notification-icon.png",
          requireInteraction: true
        }
      }
    }, {
      type: "admin_order",
      target: "admin",
      orderId,
      title,
      body
    });

    await notificationRef.set({
      status: "sent",
      requested: result.requested,
      sent: result.sent,
      failed: result.failed,
      deleted: result.deleted,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.info("[Order Push] Admin notification complete", { orderId, ...result });
  } catch (error) {
    console.error("[Order Push] Admin notification failed", { orderId, error: error.message || String(error) });
    await notificationRef.set({
      orderId,
      status: "failed",
      error: error.message || String(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => {});
  }
});

exports.createCashfreeOrder = onRequest({ region: "us-central1" }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  try {
    const { order } = req.body || {};
    validateOrder(order);

    const body = {
      order_id: order.id,
      order_amount: Math.round(Number(order.total) * 100) / 100,
      order_currency: "INR",
      customer_details: {
        customer_id: String(order.customerEmail || order.customerPhone || order.id).replace(/[^a-zA-Z0-9_-]/g, "_"),
        customer_name: order.customerName || "AFITS Customer",
        customer_email: order.customerEmail && order.customerEmail !== "Guest" ? order.customerEmail : "orders@afitsquick.com",
        customer_phone: String(order.customerPhone)
      },
      order_meta: {
        return_url: `${req.headers.origin || "https://afits-quick.vercel.app"}/?order_id=${encodeURIComponent(order.id)}`,
        notify_url: cashfreeWebhookUrl(req)
      },
      order_note: "AFITS Quick order"
    };

    const cfRes = await fetch(`${cashfreeBaseUrl()}/orders`, {
      method: "POST",
      headers: cashfreeHeaders(),
      body: JSON.stringify(body)
    });
    const data = await cfRes.json();
    if (!cfRes.ok) return res.status(cfRes.status).json(data);

    await admin.firestore().collection("payment_intents").doc(order.id).set({
      order,
      cashfreeOrderId: data.cf_order_id || "",
      paymentSessionId: data.payment_session_id || "",
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      payment_session_id: data.payment_session_id,
      cf_order_id: data.cf_order_id
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

exports.verifyCashfreeOrder = onRequest({ region: "us-central1" }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  try {
    const orderId = String(req.body?.orderId || "");
    if (!/^AQ-\d+$/.test(orderId)) throw new Error("Invalid order id");
    const cfRes = await fetch(`${cashfreeBaseUrl()}/orders/${encodeURIComponent(orderId)}/payments`, {
      headers: cashfreeHeaders()
    });
    const payments = await cfRes.json();
    if (!cfRes.ok) return res.status(cfRes.status).json(payments);

    const paid = Array.isArray(payments) && payments.some(p => p.payment_status === "SUCCESS");
    await admin.firestore().collection("payment_intents").doc(orderId).set({
      paid,
      payments,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ paid, cfOrderId: orderId, payments });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

exports.cashfreeWebhook = onRequest({ region: "us-central1" }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  try {
    if (!verifyCashfreeWebhook(req)) return res.status(401).json({ error: "Invalid webhook signature" });

    const payload = req.body || {};
    const orderId = getWebhookOrderId(payload);
    if (!/^AQ-\d+$/.test(orderId)) throw new Error("Invalid order id");

    const rawStatus = getWebhookPaymentStatus(payload);
    const paymentStatus = mapPaymentStatus(rawStatus);
    const paid = paymentStatus === "paid";
    const db = admin.firestore();
    const update = {
      paymentStatus,
      cashfreeWebhookStatus: rawStatus || "UNKNOWN",
      cashfreeWebhookEvent: payload?.type || payload?.event || "",
      cashfreeWebhookAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (paid) update.paidAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("payment_intents").doc(orderId).set({
      paid,
      paymentStatus,
      latestWebhook: payload,
      webhookUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection("orders").doc(orderId).set(update, { merge: true });

    if (paid) {
      await db.collection("admin_notifications").add({
        type: "payment",
        title: "Payment received",
        message: `Online payment received for ${orderId}`,
        orderId,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ ok: true, orderId, paymentStatus });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

exports.sendPushNotification = onRequest({ region: "us-central1" }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  const logRef = admin.firestore().collection("push_logs").doc();
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ error: "Missing admin token" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    if (decoded.isAdmin !== true) return res.status(403).json({ error: "Admin access required" });

    const title = String(req.body?.title || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!title || !body) throw new Error("Notification title and body are required");

    const targetUid = String(req.body?.targetUid || "").trim();
    const type = String(req.body?.type || "general").trim() || "general";
    const target = String(req.body?.target || "all").trim() || "all";
    const orderId = String(req.body?.orderId || "").trim();
    let tokenDocs = [];
    if (targetUid) {
      const snap = await admin.firestore().collection("fcm_tokens").where("uid", "==", targetUid).get();
      tokenDocs = snap.docs.map(doc => ({ id: doc.id, uid: doc.data().uid, token: doc.data().token }));
    } else {
      const snap = await admin.firestore().collection("fcm_tokens").get();
      tokenDocs = snap.docs.map(doc => ({ id: doc.id, uid: doc.data().uid, token: doc.data().token }));
    }
    tokenDocs = tokenDocs.filter(item => typeof item.token === "string" && item.token);

    if (!tokenDocs.length) {
      await logRef.set({
        title, body, type, target, targetUid, orderId,
        requested: 0,
        sent: 0,
        failed: 0,
        deleted: 0,
        errors: ["No FCM tokens found"],
        adminUid: decoded.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ requested: 0, sent: 0, failed: 0, deleted: 0, error: "No FCM tokens found" });
    }

    let successCount = 0;
    let failureCount = 0;
    const deletes = [];
    const errors = [];
    for (let start = 0; start < tokenDocs.length; start += 500) {
      const batch = tokenDocs.slice(start, start + 500);
      const response = await admin.messaging().sendEachForMulticast({
        tokens: batch.map(item => item.token),
        notification: { title, body },
        data: {
          title,
          body,
          type,
          target,
          targetUid,
          orderId,
          click_action: "https://afits-quick.vercel.app/"
        },
        webpush: {
          fcmOptions: { link: "https://afits-quick.vercel.app/" },
          headers: { Urgency: "high" },
          notification: {
            icon: "/icons/icon-192x192.png",
            badge: "/icons/notification-icon.png",
            requireInteraction: false
          }
        }
      });
      successCount += response.successCount;
      failureCount += response.failureCount;
      response.responses.forEach((result, index) => {
        const code = result.error?.code || "";
        if (result.error) {
          errors.push({
            tokenDocId: batch[index].id,
            uid: batch[index].uid || "",
            code,
            message: result.error.message || ""
          });
        }
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
          deletes.push(admin.firestore().collection("fcm_tokens").doc(batch[index].id).delete());
        }
      });
    }
    await Promise.all(deletes);
    await logRef.set({
      title, body, type, target, targetUid, orderId,
      requested: tokenDocs.length,
      sent: successCount,
      failed: failureCount,
      deleted: deletes.length,
      errors: errors.slice(0, 25),
      adminUid: decoded.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ requested: tokenDocs.length, sent: successCount, failed: failureCount, deleted: deletes.length });
  } catch (error) {
    await logRef.set({
      failed: 1,
      error: error.message || String(error),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
    res.status(400).json({ error: error.message });
  }
});

exports.afitsAiChat = onRequest({ region: "us-central1", timeoutSeconds: 60, memory: "512MiB" }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  const db = admin.firestore();
  const startedAt = Date.now();
  try {
    const settingsSnap = await db.collection("settings").doc("main").get();
    const settings = normalizeAiSettings(settingsSnap.exists ? settingsSnap.data() : {});
    if (!settings.enabled) return res.status(403).json({ error: "AFITS AI is disabled by admin" });

    const body = req.body || {};
    const userMessage = safeAiText(body.message, 1200);
    if (!userMessage) return res.status(400).json({ error: "Message is required" });

    const productContext = body.productContext || {};
    const conversation = Array.isArray(body.conversation)
      ? body.conversation.slice(-Math.max(1, settings.maxConversationLength - 1)).map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: safeAiText(m.content, 1600)
      })).filter(m => m.content)
      : [];

    const cacheKey = stableHash({
      message: userMessage.toLowerCase(),
      productId: productContext?.product?.id || productContext?.product?.name || "",
      productUpdated: productContext?.product?.updatedAt || "",
      related: (productContext?.relatedProducts || []).slice(0, 5).map(p => [p.id, p.price, p.stock]),
      settings: [settings.name, settings.systemPrompt]
    });

    if (body.useCache !== false) {
      const cached = await db.collection("ai_cache").doc(cacheKey).get();
      if (cached.exists) {
        const data = cached.data() || {};
        await db.collection("ai_usage").add({
          type: "chat",
          cached: true,
          productId: productContext?.product?.id || "",
          productName: safeAiText(productContext?.product?.name, 180),
          charsIn: userMessage.length,
          charsOut: String(data.answer || "").length,
          latencyMs: Date.now() - startedAt,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.json({ answer: data.answer || "", cached: true, aiName: settings.name });
      }
    }

    const messages = [
      ...buildAiPrompt({ settings, productContext, userMessage }).slice(0, 2),
      ...conversation,
      { role: "user", content: userMessage }
    ].slice(-settings.maxConversationLength);

    const grokRes = await fetch(GROK_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getGrokApiKey()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.GROK_MODEL || "grok-3-mini",
        messages,
        temperature: 0.35,
        max_tokens: 900
      })
    });
    const grokData = await grokRes.json().catch(() => ({}));
    if (!grokRes.ok) {
      const msg = grokData?.error?.message || `Grok API error ${grokRes.status}`;
      await db.collection("ai_usage").add({
        type: "chat",
        failed: true,
        status: grokRes.status,
        error: safeAiText(msg, 500),
        productId: productContext?.product?.id || "",
        productName: safeAiText(productContext?.product?.name, 180),
        latencyMs: Date.now() - startedAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(grokRes.status === 429 ? 429 : 502).json({ error: grokRes.status === 429 ? "AFITS AI is busy. Please try again in a moment." : msg });
    }

    const answer = safeAiText(grokData?.choices?.[0]?.message?.content || "", 6000);
    if (!answer) throw new Error("Empty AI response");

    await db.collection("ai_cache").doc(cacheKey).set({
      answer,
      productId: productContext?.product?.id || "",
      productName: safeAiText(productContext?.product?.name, 180),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await db.collection("ai_usage").add({
      type: "chat",
      cached: false,
      productId: productContext?.product?.id || "",
      productName: safeAiText(productContext?.product?.name, 180),
      charsIn: userMessage.length,
      charsOut: answer.length,
      latencyMs: Date.now() - startedAt,
      model: process.env.GROK_MODEL || "grok-3-mini",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ answer, cached: false, aiName: settings.name });
  } catch (error) {
    console.error("[AFITS AI] Chat failed", error);
    res.status(500).json({ error: error.message || "AFITS AI failed" });
  }
});

exports.clearAfitsAiCache = onRequest({ region: "us-central1", timeoutSeconds: 60 }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!idToken) return res.status(401).json({ error: "Missing admin token" });
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (decoded.isAdmin !== true) return res.status(403).json({ error: "Admin access required" });

    const db = admin.firestore();
    let deleted = 0;
    while (true) {
      const snap = await db.collection("ai_cache").limit(250).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(doc => {
        batch.delete(doc.ref);
        deleted++;
      });
      await batch.commit();
    }
    await db.collection("ai_usage").add({
      type: "cache_clear",
      deleted,
      adminUid: decoded.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ ok: true, deleted });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});
