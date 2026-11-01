import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
const MAX_JSON_BYTES = 32 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const SARVAM_LANGS = new Set(["en-IN", "hi-IN", "bn-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN", "gu-IN"]);
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

// Cloudflare Workers AI text-to-image.
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
  if (!cloudflareConfigured()) {
    return json(res, 503, { error: "Image proxy is not configured", code: "image_proxy_unconfigured" });
  }
  return handleCloudflareImage(req, res, await readJson(req));
}

// Sarvam text-to-speech -> WAV bytes. sampleRate is optional (e.g. 24000 for the realistic avatar).
async function sarvamTts(text, language, sampleRate) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw Object.assign(new Error("Sarvam is not configured (set SARVAM_API_KEY)"), { status: 503 });
  const attempt = async (withRate) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("upstream timeout")), 45_000);
    try {
      const payload = { text: text.slice(0, 2000), target_language_code: language };
      if (process.env.SARVAM_MODEL) payload.model = process.env.SARVAM_MODEL;
      if (process.env.SARVAM_SPEAKER) payload.speaker = process.env.SARVAM_SPEAKER;
      if (withRate) payload.speech_sample_rate = sampleRate;
      const upstream = await fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "api-subscription-key": key },
        body: JSON.stringify(payload),
      });
      const raw = await readLimited(upstream, MAX_AUDIO_BYTES);
      if (!upstream.ok) throw Object.assign(new Error(`Sarvam rejected the speech request: ${raw.toString("utf8").slice(0, 300)}`), { status: upstream.status });
      let base64;
      try { base64 = JSON.parse(raw.toString("utf8"))?.audios?.[0]; } catch { base64 = null; }
      if (!base64) throw Object.assign(new Error("Sarvam returned no audio data"), { status: 502 });
      return Buffer.from(base64, "base64");
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error("Sarvam speech timed out"), { status: 504 });
      throw error;
    } finally { clearTimeout(timeout); }
  };
  if (!sampleRate) return attempt(false);
  try { return await attempt(true); }
  catch (error) {
    if (error.status === 400 || error.status === 422) return attempt(false); // rate not accepted: resample instead
    throw error;
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

// ================================================================ realistic avatar (talking-avatar.dev)
// A photoreal person streamed to the page over WebRTC. Aria's reply is voiced by
// Sarvam on this server and pushed to the avatar, which lip-syncs and speaks it.
// The tav_ key never leaves the server. Sessions are billed per minute, so they
// close themselves when idle and have a hard time limit.
const REAL_RATE = 24000;
const REAL_RATES = new Set([8000, 12000, 16000, 24000, 48000]);
const REAL_IDLE_MS = Number(process.env.TALKING_AVATAR_IDLE_SECONDS || 180) * 1000;
const REAL_MAX_MS = Number(process.env.TALKING_AVATAR_MAX_MINUTES || 20) * 60_000;
const realSessions = new Map(); // id -> { avatar, lastUsed, createdAt }
let realSdk = null;

function realConfigured() { return Boolean(process.env.TALKING_AVATAR_API_KEY && process.env.TALKING_AVATAR_ID); }

async function loadRealSdk() {
  if (realSdk) return realSdk;
  let sdk;
  try { sdk = await import("@interviewflowai/talking-avatar/server"); }
  catch { throw Object.assign(new Error("Realistic avatar package is missing. Stop the server and run  npm install  in the project folder."), { status: 503, code: "real_sdk_missing" }); }
  let WebSocketClass = globalThis.WebSocket;
  if (!WebSocketClass) {               // Node 18/20 have no global WebSocket
    try { WebSocketClass = (await import("ws")).default; }
    catch { throw Object.assign(new Error("The ws package is missing. Run  npm install  in the project folder."), { status: 503, code: "real_sdk_missing" }); }
  }
  realSdk = { LiveAvatar: sdk.LiveAvatar, WebSocket: WebSocketClass };
  return realSdk;
}

function closeRealSession(id, why = "") {
  const session = realSessions.get(id);
  if (!session) return;
  realSessions.delete(id);
  try { session.avatar.close(); } catch {}
  if (why) console.log(`Realistic avatar session closed (${why})`);
}
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of realSessions) {
    if (s.avatar.closed) closeRealSession(id);
    else if (now - s.lastUsed > REAL_IDLE_MS) closeRealSession(id, "idle");
    else if (now - s.createdAt > REAL_MAX_MS) closeRealSession(id, "time limit");
  }
}, 15_000).unref();
process.on("SIGINT", () => { for (const id of [...realSessions.keys()]) closeRealSession(id, "server stopping"); process.exit(0); });

function realSession(id) {
  const session = typeof id === "string" ? realSessions.get(id) : null;
  if (!session || session.avatar.closed) {
    if (session) realSessions.delete(id);
    throw Object.assign(new Error("The realistic avatar session has ended"), { status: 410, code: "real_session_ended" });
  }
  session.lastUsed = Date.now();
  return session;
}

// Reads a PCM16 WAV: returns { pcm: Int16Array (mono), rate }.
export function parseWav(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4), start = off + 8;
    if (id === "fmt ") fmt = { format: b.readUInt16LE(start), channels: b.readUInt16LE(start + 2), rate: b.readUInt32LE(start + 4), bits: b.readUInt16LE(start + 14) };
    else if (id === "data") { data = b.subarray(start, Math.min(b.length, start + size)); break; }
    off = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV is missing fmt or data");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV (format ${fmt.format}, ${fmt.bits}-bit)`);
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    pcm[i] = Math.round(sum / fmt.channels);
  }
  return { pcm, rate: fmt.rate };
}

// Linear resampling to one of the rates the avatar accepts.
export function resamplePcm(pcm, from, to) {
  if (from === to) return pcm;
  const out = new Int16Array(Math.max(1, Math.round(pcm.length * to / from)));
  for (let i = 0; i < out.length; i++) {
    const x = i * from / to, i0 = Math.floor(x), f = x - i0;
    const a = pcm[Math.min(i0, pcm.length - 1)], b = pcm[Math.min(i0 + 1, pcm.length - 1)];
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

async function handleRealStart(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  if (!realConfigured()) return json(res, 503, { error: "Realistic avatar is not configured (set TALKING_AVATAR_API_KEY and TALKING_AVATAR_ID)", code: "real_unconfigured" });
  if (!process.env.SARVAM_API_KEY) return json(res, 503, { error: "The realistic avatar speaks with the Sarvam voice: set SARVAM_API_KEY too", code: "real_needs_sarvam" });
  if (realSessions.size >= 2) return json(res, 429, { error: "A realistic avatar is already running in another tab. Close it first." });
  const { LiveAvatar, WebSocket } = await loadRealSdk();
  let avatar;
  try {
    avatar = await Promise.race([
      LiveAvatar.start({ apiKey: process.env.TALKING_AVATAR_API_KEY, avatar: process.env.TALKING_AVATAR_ID, sampleRate: REAL_RATE, WebSocket }),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "timeout" })), 25_000)),
    ]);
  } catch (error) {
    const code = Number(error?.code) || 0;
    const message = code === 4001 ? "The talking-avatar API key is invalid. Check TALKING_AVATAR_API_KEY."
      : code === 4002 ? "Your talking-avatar account is out of credits (or reached its monthly limit). Add credits in the dashboard."
      : error?.code === "timeout" ? "The realistic avatar service did not respond in time."
      : `The realistic avatar could not start: ${error?.message || error}`;
    return json(res, code === 4001 ? 401 : code === 4002 ? 402 : 502, { error: message, code: "real_start_failed" });
  }
  const id = randomUUID();
  realSessions.set(id, { avatar, lastUsed: Date.now(), createdAt: Date.now() });
  avatar.on?.("close", () => realSessions.delete(id));
  return json(res, 200, { sessionId: id, width: avatar.width, height: avatar.height, idleSeconds: REAL_IDLE_MS / 1000 });
}

async function handleRealView(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  const id = new URL(req.url, "http://x").searchParams.get("session");
  const session = realSession(id);
  const body = await readJson(req);
  const clean = {};
  if (typeof body.viewId === "string" && body.viewId.length < 200) clean.viewId = body.viewId;
  if (typeof body.sdp === "string" && body.sdp.length < 30_000) clean.sdp = body.sdp;
  return json(res, 200, await session.avatar.handleView(clean));
}

async function handleRealSay(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  const body = await readJson(req);
  const session = realSession(body.sessionId);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const language = SARVAM_LANGS.has(body.language) ? body.language : "en-IN";
  if (!text) return json(res, 400, { error: "Text is required" });

  let wav;
  try { wav = await sarvamTts(text, language, REAL_RATE); }
  catch (error) { return json(res, error.status || 502, { error: error.message || "Sarvam speech failed" }); }
  let parsed;
  try { parsed = parseWav(wav); } catch (error) { return json(res, 502, { error: `Sarvam audio could not be read: ${error.message}` }); }
  const rate = REAL_RATES.has(parsed.rate) ? parsed.rate : REAL_RATE;
  const pcm = resamplePcm(parsed.pcm, parsed.rate, rate);
  session.avatar.pushAudio(pcm, { sampleRate: rate });
  session.lastUsed = Date.now();
  return json(res, 200, { durationMs: Math.round(pcm.length / rate * 1000) });
}

async function handleRealClear(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  const body = await readJson(req);
  const session = realSession(body.sessionId);
  const heardMs = await Promise.race([session.avatar.clear(), new Promise((r) => setTimeout(() => r(null), 3000))]);
  return json(res, 200, { heardMs });
}

async function handleRealStop(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "Cross-origin requests are not allowed" });
  const body = await readJson(req);
  closeRealSession(typeof body.sessionId === "string" ? body.sessionId : "", "ended by user");
  return json(res, 200, { stopped: true });
}

// The browser viewer ships inside the npm package; serve only its .js files.
async function serveRealViewer(req, res, file) {
  if (!/^[\w.-]+\.js$/.test(file)) return json(res, 404, { error: "Not found" });
  const dir = path.join(ROOT, "node_modules", "@interviewflowai", "talking-avatar", "dist");
  try {
    const data = await readFile(path.join(dir, file));
    res.writeHead(200, secureHeaders({ "Content-Type": "text/javascript; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-cache" }));
    res.end(data);
  } catch {
    json(res, 404, { error: "Realistic avatar viewer not installed. Run npm install." });
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
        imageProxy: cloudflareConfigured(),
        sarvamProxy: Boolean(process.env.SARVAM_API_KEY),
        realAvatar: realConfigured() && Boolean(process.env.SARVAM_API_KEY),
      });
    }
    if (req.url?.split("?")[0] === "/api/image/generate") return await handleImage(req, res);
    if (req.url?.split("?")[0] === "/api/sarvam/speech") return await handleSarvamSpeech(req, res);
    const route = req.url?.split("?")[0] || "";
    if (route === "/api/realavatar/start") return await handleRealStart(req, res);
    if (route === "/api/realavatar/view") return await handleRealView(req, res);
    if (route === "/api/realavatar/say") return await handleRealSay(req, res);
    if (route === "/api/realavatar/clear") return await handleRealClear(req, res);
    if (route === "/api/realavatar/stop") return await handleRealStop(req, res);
    if (route.startsWith("/vendor/talking-avatar/")) return await serveRealViewer(req, res, route.slice("/vendor/talking-avatar/".length));
    return await serveStatic(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : "Internal server error", ...(error.code && typeof error.code === "string" ? { code: error.code } : {}) });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Aria running at http://${HOST}:${PORT}`);
  console.log(cloudflareConfigured() ? "Cloudflare Workers AI image proxy enabled" : "Image proxy disabled (set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)");
  console.log(process.env.SARVAM_API_KEY ? "Sarvam speech proxy enabled" : "Sarvam speech proxy disabled (set SARVAM_API_KEY or use browser fallback)");
  console.log(realConfigured() ? "Realistic avatar (talking-avatar.dev) enabled" : "Realistic avatar disabled (set TALKING_AVATAR_API_KEY + TALKING_AVATAR_ID)");
});
