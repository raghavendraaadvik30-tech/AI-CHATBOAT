import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
const MAX_JSON_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
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

async function handleImage(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    return json(res, 415, { error: "Expected application/json" });
  }

  const key = process.env.STABILITY_API_KEY;
  if (!key) return json(res, 503, { error: "Image proxy is not configured", code: "image_proxy_unconfigured" });

  const body = await readJson(req);
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
    form.append("output_format", "webp");

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

async function handleSonexSpeech(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    return json(res, 415, { error: "Expected application/json" });
  }

  const key = process.env.SONEX_API_KEY;
  if (!key) return json(res, 503, { error: "Sonex proxy is not configured", code: "sonex_proxy_unconfigured" });
  const body = await readJson(req);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const voiceId = String(process.env.SONEX_VOICE_ID || body.voiceId || "").trim();
  if (!text) return json(res, 400, { error: "Text is required" });
  if (text.length > 10_000) return json(res, 400, { error: "Text must be 10000 characters or fewer" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), 45_000);
  const abortOnClose = () => { if (!res.writableEnded) controller.abort(new Error("client disconnected")); };
  res.on("close", abortOnClose);

  try {
    const payload = { text, output_format: "wav", speed: 1 };
    if (voiceId) payload.voice_id = voiceId;
    const upstream = await fetch("https://api.sonexlabs.com/v1/speech/stream", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "audio/wav",
      },
      body: JSON.stringify(payload),
    });
    if (!upstream.ok) {
      const errorBody = await readLimited(upstream, 256 * 1024);
      return json(res, upstream.status, {
        error: "SonexLabs rejected the speech request",
        detail: errorBody.toString("utf8").slice(0, 500),
      });
    }
    const contentType = String(upstream.headers.get("content-type") || "audio/wav").split(";")[0];
    if (!contentType.startsWith("audio/")) return json(res, 502, { error: "SonexLabs returned a non-audio response" });
    const audio = await readLimited(upstream, MAX_AUDIO_BYTES);
    res.writeHead(200, secureHeaders({
      "Content-Type": contentType,
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
        imageProxy: Boolean(process.env.STABILITY_API_KEY),
        sonexProxy: Boolean(process.env.SONEX_API_KEY),
      });
    }
    if (req.url?.split("?")[0] === "/api/stability/generate") return await handleImage(req, res);
    if (req.url?.split("?")[0] === "/api/sonex/speech") return await handleSonexSpeech(req, res);
    return await serveStatic(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "Internal server error" });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Aria running at http://${HOST}:${PORT}`);
  console.log(process.env.STABILITY_API_KEY ? "Stability proxy enabled" : "Stability proxy disabled (set STABILITY_API_KEY or use browser fallback)");
  console.log(process.env.SONEX_API_KEY ? "Sonex speech proxy enabled" : "Sonex speech proxy disabled (set SONEX_API_KEY or use browser fallback)");
});
