module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "POST required" }));
  }

  let deleted = 0;
  try {
    const ai = require("./afits-ai");
    if (typeof ai._clearAfitsAiCache === "function") deleted = ai._clearAfitsAiCache();
  } catch {}

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ok: true, deleted }));
};
