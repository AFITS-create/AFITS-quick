const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const XAI_API_URL = "https://api.x.ai/v1/chat/completions";

const responseCache = new Map();
const pendingRequests = new Map();

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function safeText(value, max = 4000) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function getProviderConfig() {
  const key = process.env.GROK_API_KEY || process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROK_API_KEY is not configured in Vercel Environment Variables");

  const requestedModel = safeText(process.env.GROK_MODEL || process.env.GROQ_MODEL || "", 80);
  const isGroqKey = key.startsWith("gsk_");

  if (isGroqKey) {
    return {
      key,
      url: GROQ_API_URL,
      model: requestedModel && !requestedModel.startsWith("grok-") ? requestedModel : "llama-3.3-70b-versatile"
    };
  }

  return {
    key,
    url: XAI_API_URL,
    model: requestedModel || "grok-4"
  };
}

function buildProductContext(product = {}) {
  const lines = [
    `Product Name: ${safeText(product.name, 200)}`,
    `Brand: ${safeText(product.brand, 120)}`,
    `Category: ${safeText(product.category, 120)}`,
    `Price: ${safeText(product.price, 80)}`,
    `Discount: ${safeText(product.discount || product.offer, 120)}`,
    `Rating: ${safeText(product.rating, 80)}`,
    `Reviews: ${safeText(product.reviews, 800)}`,
    `Description: ${safeText(product.description, 1500)}`,
    `Specifications: ${safeText(JSON.stringify(product.specifications || product.specs || {}), 1800)}`,
    `Warranty: ${safeText(product.warranty, 500)}`,
    `Stock: ${safeText(product.stock ?? product.qty ?? product.quantity, 120)}`,
    `Seller: ${safeText(product.seller, 200)}`,
    `Delivery Time: ${safeText(product.deliveryTime || product.delivery || product.eta, 300)}`,
    `Images: ${safeText((product.images || product.image || "").toString(), 500)}`,
    `Similar Products: ${safeText(JSON.stringify(product.similarProducts || []), 1200)}`,
    `Related Products: ${safeText(JSON.stringify(product.relatedProducts || []), 1200)}`
  ];
  return lines.filter(line => !line.endsWith(": ")).join("\n");
}

function buildMessages(body) {
  const productContext = buildProductContext(body.product || body.productContext || {});
  const message = safeText(body.message || body.question, 1200);
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const settings = body.settings || {};
  const systemPrompt = safeText(settings.systemPrompt, 2500) ||
    "You are AFITS AI, a shopping assistant for AFITS Quick. Help customers choose and understand products available inside AFITS Quick. Use the provided product/store context first. Do not answer unrelated world questions. If a question is unrelated to shopping or AFITS Quick products, politely say that AFITS AI specializes in helping customers choose and understand products available in AFITS Quick. Be concise, practical, honest, and customer-friendly. Never invent stock, price, warranty, or delivery claims outside the provided context.";

  return [
    {
      role: "system",
      content: `${systemPrompt}\n\nCurrent product/store context:\n${productContext || "No product context provided."}`
    },
    ...history
      .filter(m => m && (m.role === "user" || m.role === "assistant"))
      .map(m => ({ role: m.role, content: safeText(m.content, 1200) })),
    { role: "user", content: message || "Help me understand this product." }
  ];
}

function cacheKeyFor(body) {
  return JSON.stringify({
    message: safeText(body.message || body.question, 500),
    product: safeText(JSON.stringify(body.product || body.productContext || {}), 2000),
    settings: safeText(JSON.stringify(body.settings || {}), 1000)
  });
}

async function callAi(body) {
  const provider = getProviderConfig();
  const messages = buildMessages(body);

  const aiRes = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: 0.45,
      max_tokens: 900
    })
  });

  const data = await aiRes.json().catch(() => ({}));
  if (!aiRes.ok) {
    const msg = data?.error?.message || data?.message || "AFITS AI provider request failed";
    const err = new Error(msg);
    err.status = aiRes.status;
    throw err;
  }

  return {
    answer: data?.choices?.[0]?.message?.content || "I could not generate an answer right now.",
    cached: false,
    aiName: safeText(body?.settings?.name, 80) || "AFITS AI"
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "POST") return json(res, 405, { error: "POST required" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const key = cacheKeyFor(body);
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.time < 1000 * 60 * 20) {
      return json(res, 200, { ...cached.data, cached: true });
    }

    if (pendingRequests.has(key)) {
      const data = await pendingRequests.get(key);
      return json(res, 200, { ...data, cached: true });
    }

    const promise = callAi(body);
    pendingRequests.set(key, promise);
    const data = await promise;
    pendingRequests.delete(key);
    responseCache.set(key, { time: Date.now(), data });

    return json(res, 200, data);
  } catch (error) {
    pendingRequests.clear();
    const status = error.status === 429 ? 429 : 500;
    return json(res, status, {
      error: status === 429 ? "AFITS AI is busy. Please try again in a moment." : (error.message || "AFITS AI failed")
    });
  }
};

module.exports._clearAfitsAiCache = function clearAfitsAiCache() {
  const deleted = responseCache.size;
  responseCache.clear();
  pendingRequests.clear();
  return deleted;
};
