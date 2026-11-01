import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
const MAX_JSON_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const SARVAM_LANGS = new Set(["en-IN", "hi-IN", "bn-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN", "gu-IN"]);
const ENGINES = new Set(["core", "ultra"]);
const ASPECTS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
};

function secureHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...extra,
  };
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, secureHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  }));
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw Object.assign(new Error("Request is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

async function readLimited(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel("response too large");
      throw Object.assign(new Error("Upstream response is too large"), { status: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; }
  catch { return false; }
}

const CF_DIMENSIONS = {
  "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "4:3": [1152, 896], "3:4": [896, 1152],
};

function cloudflareConfigured() {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);
}

// Cloudflare Workers AI text-to-image (used when no Stability key is set).
async function handleCloudflareImage(req, res, body) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const aspectRatio = ASPECTS.has(body.aspectRatio) ? body.aspectRatio : "1:1";
  if (!prompt) return json(res, 400, { error: "Prompt is required" });
  if (prompt.length > 2048) return json(res, 400, { error: "Prompt must be 2048 characters or fewer" });

  const model = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
  const isFlux = model.includes("flux");
  const [width, height] = CF_DIMENSIONS[aspectRatio];
  const payload = isFlux ? { prompt, steps: 6 } : { prompt, width, height };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), 105_000);
  const abortOnClose = () => { if (!res.writableEnded) controller.abort(new Error("client disconnected")); };
  res.on("close", abortOnClose);

  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${model}`;
    const upstream = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const raw = await readLimited(upstream, MAX_IMAGE_BYTES * 2);
    const type = String(upstream.headers.get("content-type") || "");
    if (!upstream.ok) {
      return json(res, upstream.status, { error: "Cloudflare rejected the request", detail: raw.toString("utf8").slice(0, 500) });
    }

    let image, contentType = "image/png";
    if (type.startsWith("image/")) {
      image = raw; contentType = type.split(";")[0];
    } else {
      let b64;
      try { b64 = JSON.parse(raw.toString("utf8"))?.result?.image; } catch { b64 = null; }
      if (!b64) return json(res, 502, { error: "Cloudflare returned no image data" });
      image = Buffer.from(b64, "base64");
      if (image[0] === 0xff && image[1] === 0xd8) contentType = "image/jpeg";
    }
    if (image.length > MAX_IMAGE_BYTES) return json(res, 502, { error: "Generated image exceeds the size limit" });

    res.writeHead(200, secureHeaders({
      "Content-Type": contentType,
      "Content-Length": image.length,
      "Cache-Control": "no-store",
    }));
    res.end(image);
  } catch (error) {
    if (controller.signal.aborted) {
      if (!res.headersSent && !res.destroyed) json(res, 504, { error: "Image generation timed out or was cancelled" });
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    res.off("close", abortOnClose);
  }
}

async function handleImage(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    return json(res, 415, { error: "Expected application/json" });
  }

  const key = process.env.STABILITY_API_KEY;
  if (!key && !cloudflareConfigured()) {
    return json(res, 503, { error: "Image proxy is not configured", code: "image_proxy_unconfigured" });
  }

  const body = await readJson(req);
  if (!key) return handleCloudflareImage(req, res, body);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const engine = ENGINES.has(body.engine) ? body.engine : "core";
  const aspectRatio = ASPECTS.has(body.aspectRatio) ? body.aspectRatio : "1:1";
  if (!prompt) return json(res, 400, { error: "Prompt is required" });
  if (prompt.length > 4000) return json(res, 400, { error: "Prompt must be 4000 characters or fewer" });

  const controller = new AbortController();
  const timeoutMs = engine === "ultra" ? 165_000 : 105_000;
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
  const abortOnClose = () => { if (!res.writableEnded) controller.abort(new Error("client disconnected")); };
  res.on("close", abortOnClose);

  try {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("aspect_ratio", aspectRatio);
    form.append("output_format", "png");

    const upstream = await fetch(`https://api.stability.ai/v2beta/stable-image/generate/${engine}`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, Accept: "image/*" },
      body: form,
    });

    if (!upstream.ok) {
      const errorBody = await readLimited(upstream, 256 * 1024);
      const detail = errorBody.toString("utf8").slice(0, 500);
      return json(res, upstream.status, { error: "Stability AI rejected the request", detail });
    }

    const contentType = String(upstream.headers.get("content-type") || "").split(";")[0];
    if (!contentType.startsWith("image/")) return json(res, 502, { error: "Stability AI returned a non-image response" });
    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > MAX_IMAGE_BYTES) return json(res, 502, { error: "Generated image exceeds the size limit" });

    const image = await readLimited(upstream, MAX_IMAGE_BYTES);
    res.writeHead(200, secureHeaders({
      "Content-Type": contentType,
      "Content-Length": image.length,
      "Cache-Control": "no-store",
    }));
    res.end(image);
  } catch (error) {
    if (controller.signal.aborted) {
      if (!res.headersSent && !res.destroyed) json(res, 504, { error: "Image generation timed out or was cancelled" });
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    res.off("close", abortOnClose);
  }
}

async function handleSarvamSpeech(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    return json(res, 415, { error: "Expected application/json" });
  }

  const key = process.env.SARVAM_API_KEY;
  if (!key) return json(res, 503, { error: "Sarvam proxy is not configured", code: "sarvam_proxy_unconfigured" });

  const body = await readJson(req);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const language = SARVAM_LANGS.has(body.language) ? body.language : "en-IN";
  if (!text) return json(res, 400, { error: "Text is required" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), 45_000);
  const abortOnClose = () => { if (!res.writableEnded) controller.abort(new Error("client disconnected")); };
  res.on("close", abortOnClose);

  try {
    const payload = { text: text.slice(0, 2000), target_language_code: language };
    if (process.env.SARVAM_MODEL) payload.model = process.env.SARVAM_MODEL;
    if (process.env.SARVAM_SPEAKER) payload.speaker = process.env.SARVAM_SPEAKER;

    const upstream = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "api-subscription-key": key },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errorBody = await readLimited(upstream, 256 * 1024);
      return json(res, upstream.status, {
        error: "Sarvam rejected the speech request",
        detail: errorBody.toString("utf8").slice(0, 500),
      });
    }

    const raw = await readLimited(upstream, MAX_AUDIO_BYTES);
    let base64;
    try { base64 = JSON.parse(raw.toString("utf8"))?.audios?.[0]; } catch { base64 = null; }
    if (!base64) return json(res, 502, { error: "Sarvam returned no audio data" });

    const audio = Buffer.from(base64, "base64");
    res.writeHead(200, secureHeaders({
      "Content-Type": "audio/wav",
      "Content-Length": audio.length,
      "Cache-Control": "no-store",
    }));
    res.end(audio);
  } catch (error) {
    if (controller.signal.aborted) {
      if (!res.headersSent && !res.destroyed) json(res, 504, { error: "Speech generation timed out or was cancelled" });
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    res.off("close", abortOnClose);
  }
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname); }
  catch { return json(res, 400, { error: "Invalid URL" }); }
  if (pathname === "/") pathname = "/index.html";
  if (pathname.split("/").some((segment) => segment.startsWith(".") && segment !== ".")) {
    return json(res, 404, { error: "Not found" });
  }

  const file = path.resolve(ROOT, `.${pathname}`);
  if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) return json(res, 403, { error: "Forbidden" });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const data = await readFile(file);
    res.writeHead(200, secureHeaders({
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    }));
    if (req.method === "HEAD") res.end(); else res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.split("?")[0] === "/api/capabilities") {
      return json(res, 200, {
        imageProxy: Boolean(process.env.STABILITY_API_KEY) || cloudflareConfigured(),
        sarvamProxy: Boolean(process.env.SARVAM_API_KEY),
      });
    }
    if (req.url?.split("?")[0] === "/api/stability/generate") return await handleImage(req, res);
    if (req.url?.split("?")[0] === "/api/sarvam/speech") return await handleSarvamSpeech(req, res);
    return await serveStatic(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Aria running at http://${HOST}:${PORT}`);
  console.log(process.env.STABILITY_API_KEY ? "Stability proxy enabled"
    : cloudflareConfigured() ? "Cloudflare Workers AI image proxy enabled"
    : "Image proxy disabled (set STABILITY_API_KEY or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)");
  console.log(process.env.SARVAM_API_KEY ? "Sarvam speech proxy enabled" : "Sarvam speech proxy disabled (set SARVAM_API_KEY or use browser fallback)");
});
