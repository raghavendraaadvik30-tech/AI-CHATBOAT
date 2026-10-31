// ========================================================================
// Aria — AI Avatar Chat
// A small, dependency-free chat client for OpenRouter with an animated
// SVG avatar that blinks, breathes, and "talks" while responding.
// ========================================================================

const KEY_STORE = "aria.apiKey";
const MODEL_STORE = "aria.model";
const PERSONA_STORE = "aria.persona";
const VOICE_STORE = "aria.voice";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_PERSONA =
  "You are Aria, a warm, upbeat and friendly AI companion. " +
  "Keep replies concise, natural and human. Use a little personality and the occasional emoji. " +
  "When the user shares their camera, an image of what their webcam sees is attached to their message — " +
  "look at it and answer naturally about what you see (count fingers, describe colours/objects, etc.).";

// ---- element refs ----
const el = (id) => document.getElementById(id);
const messagesBox = el("messages");
const typing = el("typing");
const composer = el("composer");
const input = el("input");
const sendBtn = el("sendBtn");
const statusPill = el("statusPill");
const statusText = el("statusText");

const modal = el("modal");
const apiKeyInput = el("apiKey");
const modelInput = el("model");
const personaInput = el("persona");

// ---- conversation state ----
let history = []; // {role, content}

// ------------------------------------------------------------------ safe store
// Some browsers throw a SecurityError when touching localStorage on a file://
// page (or when storage is disabled). Fall back to an in-memory store so the
// app never crashes — settings just won't persist across reloads in that case.
const memStore = {};
let storageWorks = true;
const store = {
  get(k) {
    try { return localStorage.getItem(k); }
    catch { storageWorks = false; return k in memStore ? memStore[k] : null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); }
    catch { storageWorks = false; memStore[k] = v; }
  },
};

// ------------------------------------------------------------------ settings
function loadSettings() {
  apiKeyInput.value = store.get(KEY_STORE) || "";
  modelInput.value = store.get(MODEL_STORE) || DEFAULT_MODEL;
  personaInput.value = store.get(PERSONA_STORE) || DEFAULT_PERSONA;
}
function getKey() { return store.get(KEY_STORE) || ""; }
function getModel() { return store.get(MODEL_STORE) || DEFAULT_MODEL; }
function getPersona() { return store.get(PERSONA_STORE) || DEFAULT_PERSONA; }

function openModal() { loadSettings(); modal.hidden = false; }
function closeModal() { modal.hidden = true; }

el("settingsBtn").addEventListener("click", openModal);
el("closeModal").addEventListener("click", closeModal);

const saveBtn = el("saveSettings");
saveBtn.addEventListener("click", () => {
  // Never let an exception stop the modal from closing or feedback from showing.
  store.set(KEY_STORE, apiKeyInput.value.trim());
  store.set(MODEL_STORE, modelInput.value.trim() || DEFAULT_MODEL);
  store.set(PERSONA_STORE, personaInput.value.trim() || DEFAULT_PERSONA);

  const original = saveBtn.textContent;
  saveBtn.textContent = "Saved ✓";
  setTimeout(() => {
    saveBtn.textContent = original;
    closeModal();
    setStatus("Online");
    if (!storageWorks) {
      toast("Settings won't persist — your browser is blocking storage (common on file:// pages). Run from a local server to keep them.", "error");
    }
  }, 550);
});
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

// ------------------------------------------------------------------ voice toggle
const voiceBtn = el("voiceBtn");
function applyVoice(on) {
  window.ariaAvatar?.setVoice(on);
  voiceBtn.textContent = on ? "🔊" : "🔇";
  voiceBtn.title = on ? "Voice on — click to mute" : "Voice off — click to unmute";
}
voiceBtn.addEventListener("click", () => {
  const currentlyOn = store.get(VOICE_STORE) !== "off"; // default on
  const next = !currentlyOn;
  store.set(VOICE_STORE, next ? "on" : "off");
  applyVoice(next);
  if (next) window.ariaAvatar?.primeVoice?.(); // unlock audio on this gesture
});

// ------------------------------------------------------------------ avatar fx
// The 3D engine (avatar3d.js) owns blinking + idle motion. We only toggle
// the talking state so the mouth syncs to replies.
function startTalking() { window.ariaAvatar?.startTalking(); }
function stopTalking() { window.ariaAvatar?.stopTalking(); }

function setStatus(text, thinking = false) {
  statusText.textContent = text;
  statusPill.classList.toggle("thinking", thinking);
}

// ------------------------------------------------------------------ messages
// Chat bubbles are ONLY for real content: what the user sends and what the
// model actually replies. App notifications use toast() instead, so nothing
// is ever faked as if Aria said it.
function addMessage(role, text) {
  const hint = el("emptyHint");
  if (hint) hint.remove();
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "me" : "bot");
  div.textContent = text;
  messagesBox.appendChild(div);
  messagesBox.scrollTop = messagesBox.scrollHeight;
  return div;
}

// transient, dismissable notification (not part of the conversation)
const toastsBox = el("toasts");
function toast(msg, type = "info", ms) {
  if (!toastsBox) return;
  const d = document.createElement("div");
  d.className = "toast " + type;
  d.textContent = msg;
  toastsBox.appendChild(d);
  const life = ms || (type === "error" ? 7000 : 3500);
  const timer = setTimeout(dismiss, life);
  function dismiss() { clearTimeout(timer); d.classList.add("out"); setTimeout(() => d.remove(), 250); }
  d.addEventListener("click", dismiss);
}

function showTyping(on) {
  typing.hidden = !on;
  if (on) messagesBox.scrollTop = messagesBox.scrollHeight;
}

// On a file:// page, location.origin is the string "null", which OpenRouter
// rejects as a Referer. Fall back to a valid URL in that case.
function referer() {
  const o = location.origin;
  return o && o !== "null" ? o : "https://aria-avatar-chat.local";
}

// ------------------------------------------------------------------ API call
async function askOpenRouter(userText, imageDataUrl = null) {
  const key = getKey();
  if (!key) {
    openModal();
    toast("Add your OpenRouter API key in settings first.", "error");
    return;
  }

  // Store plain text in history (so we don't resend heavy image bytes every turn).
  history.push({ role: "user", content: userText });

  const messages = [{ role: "system", content: getPersona() }, ...history];
  // Attach the camera frame to just the current message (OpenAI-style vision).
  if (imageDataUrl) {
    messages[messages.length - 1] = {
      role: "user",
      content: [
        { type: "text", text: userText || "What do you see?" },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    };
  }

  const payload = { model: getModel(), messages };

  setStatus("Thinking…", true);
  showTyping(true);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
        "HTTP-Referer": referer(),
        "X-Title": "Aria Avatar Chat",
      },
      body: JSON.stringify(payload),
    });

    showTyping(false);

    if (!res.ok) {
      const errText = await res.text();
      setStatus("Online");
      toast(`API error (${res.status}): ${errText.slice(0, 200)}`, "error", 10000);
      return;
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "(no response)";
    history.push({ role: "assistant", content: reply });

    setStatus("Speaking…");
    // Speak aloud + lip-sync (if the engine is ready) while the text reveals.
    const spoken = window.ariaAvatar?.speak
      ? window.ariaAvatar.speak(reply)
      : (startTalking(), Promise.resolve());
    await typeOut(reply);
    await spoken;            // wait for speech + lip-sync to finish
    stopTalking();
    setStatus("Online");
  } catch (err) {
    showTyping(false);
    stopTalking();
    setStatus("Online");
    toast("Network error: " + err.message, "error", 10000);
  }
}

// Reveal the reply character-by-character so the mouth animation feels synced
function typeOut(text) {
  return new Promise((resolve) => {
    const div = addMessage("assistant", "");
    let i = 0;
    const step = Math.max(1, Math.round(text.length / 140)); // keep it snappy
    const timer = setInterval(() => {
      i += step;
      div.textContent = text.slice(0, i);
      messagesBox.scrollTop = messagesBox.scrollHeight;
      if (i >= text.length) {
        div.textContent = text;
        clearInterval(timer);
        resolve();
      }
    }, 18);
  });
}

// ------------------------------------------------------------------ camera (vision)
const cameraBtn = el("cameraBtn");
const cameraEl = el("camera");
const camPreview = el("camPreview");
let camStream = null;
let cameraOn = false;

let camStarting = false;
async function startCamera() {
  if (cameraOn || camStarting) return; // guard against double-clicks
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This browser can't access the camera here.", "error");
    return;
  }
  camStarting = true;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    cameraEl.srcObject = camStream;
    await cameraEl.play().catch(() => {});
    camPreview.hidden = false;
    cameraOn = true;
    cameraBtn.classList.add("active");
    cameraBtn.title = "Camera on — click to turn off";
    toast("Camera on — Aria can see you now.", "info");
  } catch (e) {
    toast("Couldn't open the camera. Allow camera permission, then tap 📷 again.", "error");
  } finally {
    camStarting = false;
  }
}

function stopCamera() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  cameraEl.srcObject = null;
  camPreview.hidden = true;
  cameraOn = false;
  cameraBtn.classList.remove("active");
  cameraBtn.title = "Let Aria see you (camera)";
}

// grab the current webcam frame as a compressed JPEG data URL
function captureFrame() {
  const v = cameraEl;
  if (!v || !v.videoWidth) return null;
  const maxW = 640;
  const scale = Math.min(1, maxW / v.videoWidth);
  const w = Math.round(v.videoWidth * scale);
  const h = Math.round(v.videoHeight * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(v, 0, 0, w, h);
  try { return c.toDataURL("image/jpeg", 0.8); } catch { return null; }
}

cameraBtn.addEventListener("click", () => { cameraOn ? stopCamera() : startCamera(); });

// ------------------------------------------------------------------ submit
function sendText(text) {
  const t = (text || "").trim();
  if (!t) return;
  const img = cameraOn ? captureFrame() : null; // snapshot of what Aria sees
  addMessage("user", img ? t + "  📷" : t);
  input.value = "";
  askOpenRouter(t, img);
}
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  // Unlock speech synthesis while we still have the click's user activation.
  window.ariaAvatar?.primeVoice?.();
  sendText(input.value);
});

// ------------------------------------------------------------------ voice command (speech-to-text)
const micBtn = el("micBtn");
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let listening = false;

function stopListening() {
  listening = false;
  micBtn.classList.remove("listening");
  try { recog && recog.stop(); } catch {}
}

function startListening() {
  if (!recog) return;
  // Don't let Aria's own voice bleed into the mic.
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  input.value = "";
  input.placeholder = "Listening… speak now";
  listening = true;
  micBtn.classList.add("listening");
  try { recog.start(); } catch {}
}

if (SR) {
  recog = new SR();
  recog.lang = "en-US";
  recog.interimResults = true;
  recog.continuous = false;
  recog.maxAlternatives = 1;

  recog.onresult = (e) => {
    let txt = "";
    for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
    input.value = txt;
    const last = e.results[e.results.length - 1];
    if (last && last.isFinal) {
      stopListening();
      sendText(txt);
    }
  };
  recog.onerror = (e) => {
    stopListening();
    if (e && (e.error === "not-allowed" || e.error === "service-not-allowed")) {
      toast("Couldn't access the microphone. Allow mic permission, then tap 🎤 again.", "error");
    }
  };
  recog.onend = () => { input.placeholder = "Say something to Aria…"; stopListening(); };

  micBtn.addEventListener("click", () => {
    window.ariaAvatar?.primeVoice?.();
    listening ? stopListening() : startListening();
  });
} else {
  // No speech recognition support (e.g. Firefox) — hide the mic button.
  micBtn.style.display = "none";
}

// ------------------------------------------------------------------ init
function init() {
  try { loadSettings(); } catch (e) { /* storage blocked — handled by safe store */ }
  applyVoice(store.get(VOICE_STORE) !== "off"); // default: voice on
  // No fake greeting — the empty-state hint in #messages guides the user,
  // and the chat only ever shows real user/model exchanges.
}
init();
