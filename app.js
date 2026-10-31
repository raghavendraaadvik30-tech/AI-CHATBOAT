// ========================================================================
// Aria — AI Avatar Chat
// A small, dependency-free chat client for OpenRouter with an animated
// SVG avatar that blinks, breathes, and "talks" while responding.
// ========================================================================

const KEY_STORE = "aria.apiKey";
const MODEL_STORE = "aria.model";
const PERSONA_STORE = "aria.persona";
const VOICE_STORE = "aria.voice";
const VOICE_NAME_STORE = "aria.voiceName";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_PERSONA =
  "You are Aria, a warm, upbeat and friendly AI companion. " +
  "Keep replies concise, natural and human. Use a little personality and the occasional emoji. " +
  "When the user shares their camera, an image of what their webcam sees is attached to their message. " +
  "Examine the image carefully before answering. For counting (e.g. fingers), count the clearly visible items one by one and give the exact number. " +
  "For colours, name the actual colour you see. Be precise and concrete; if the image is blurry or something is not clearly visible, say so briefly rather than guessing.";

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
const voiceSelect = el("voiceSelect");

// ---- conversation state ----
let history = []; // {role, content}
let liveMode = false;   // hands-free continuous voice conversation
let processing = false; // a turn (send -> reply -> speak) is in progress
let currentController = null; // lets "stop" abort an in-flight request

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
  populateVoices();
}

// fill the voice dropdown with the browser's installed voices
function populateVoices() {
  if (!voiceSelect) return;
  const chosen = store.get(VOICE_NAME_STORE) || "";
  const list = window.ariaAvatar?.listVoices?.() || [];
  voiceSelect.innerHTML = '<option value="">Automatic (male)</option>';
  for (const v of list) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    if (v.name === chosen) o.selected = true;
    voiceSelect.appendChild(o);
  }
  voiceSelect.value = chosen; // keep "Automatic" if the saved voice isn't present
}
// voices can load late — repopulate when the browser reports them
try { if (window.speechSynthesis) window.speechSynthesis.addEventListener("voiceschanged", populateVoices); } catch {}
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
  store.set(VOICE_NAME_STORE, voiceSelect ? voiceSelect.value : "");
  window.ariaAvatar?.setVoiceName?.(voiceSelect ? voiceSelect.value : "");

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

// instant preview when a voice is chosen (the change event is a user gesture)
voiceSelect?.addEventListener("change", () => {
  window.ariaAvatar?.setVoiceName?.(voiceSelect.value);
  window.ariaAvatar?.primeVoice?.();
  window.ariaAvatar?.speak?.("Hi, this is how I sound.");
});

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
  window.ariaAvatar?.setThinking?.(thinking);
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
        { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
      ],
    };
  }

  const payload = { model: getModel(), messages };

  setStatus("Thinking…", true);
  showTyping(true);
  currentController = new AbortController();

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: currentController.signal,
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
    if (err && err.name === "AbortError") return; // user said "stop" — not an error
    toast("Network error: " + err.message, "error", 10000);
  } finally {
    currentController = null;
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
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
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
  const maxW = 1024; // higher detail -> better finger/colour/object accuracy
  const scale = Math.min(1, maxW / v.videoWidth);
  const w = Math.round(v.videoWidth * scale);
  const h = Math.round(v.videoHeight * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(v, 0, 0, w, h);
  try { return c.toDataURL("image/jpeg", 0.88); } catch { return null; }
}

cameraBtn.addEventListener("click", () => { cameraOn ? stopCamera() : startCamera(); });

// ------------------------------------------------------------------ submit
async function sendText(text) {
  const t = (text || "").trim();
  if (!t) return;
  const img = cameraOn ? captureFrame() : null; // snapshot of what Aria sees
  addMessage("user", img ? t + "  📷" : t);
  input.value = "";
  processing = true;
  try {
    await askOpenRouter(t, img); // resolves after Aria finishes speaking
  } finally {
    processing = false;
    // hands-free: once she's done replying, listen again for the next turn
    if (liveMode) setTimeout(() => { if (liveMode && !listening && !processing) startListening(); }, 450);
  }
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
  window.ariaAvatar?.setListening?.(false);
  try { recog && recog.stop(); } catch {}
}

function startListening() {
  if (!recog || listening) return;
  if (!liveMode) { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {} }
  recog.continuous = liveMode;  // live keeps listening (so you can barge-in with "stop")
  input.value = "";
  input.placeholder = "Listening… speak now";
  listening = true;
  micBtn.classList.add("listening");
  window.ariaAvatar?.setListening?.(true);
  setStatus("Listening…");
  try { recog.start(); } catch {}
}

// spoken commands
const STOP_RE = /\b(stop|wait|hold on|enough|shut up|cancel|pause|quiet)\b/i;
const EXIT_RE = /\b(exit|good ?bye|bye|end call|hang ?up|quit|stop conversation)\b/i;
function isShort(t) { return t.trim().split(/\s+/).length <= 3; }

function interruptSpeech() {
  try { currentController && currentController.abort(); } catch {}
  window.ariaAvatar?.stopTalking?.(); // cancels speech + resolves the turn
  setStatus("Listening…");
}

if (SR) {
  recog = new SR();
  recog.lang = "en-US";
  recog.interimResults = true;
  recog.continuous = false;
  recog.maxAlternatives = 1;

  recog.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    const txt = ((last && last[0] && last[0].transcript) || "").trim();
    if (!txt) return;

    if (liveMode) {
      // "exit"/"bye" ends the live call at any time
      if (EXIT_RE.test(txt) && isShort(txt) && (last.isFinal || processing)) { stopLive(); return; }
      // while Aria is replying/speaking: only listen for a "stop" barge-in, ignore the rest (echo)
      if (processing) {
        if (STOP_RE.test(txt) && isShort(txt)) interruptSpeech();
        return;
      }
      // normal turn
      input.value = txt;
      if (last.isFinal) { input.value = ""; sendText(txt); }
      return;
    }

    // push-to-talk (single utterance)
    input.value = txt;
    if (last.isFinal) { stopListening(); sendText(txt); }
  };
  recog.onerror = (e) => {
    stopListening();
    if (e && (e.error === "not-allowed" || e.error === "service-not-allowed")) {
      toast("Couldn't access the microphone. Allow mic permission, then tap 🎤 again.", "error");
    }
  };
  recog.onend = () => {
    input.placeholder = "Say something to Aria…";
    listening = false;
    micBtn.classList.remove("listening");
    window.ariaAvatar?.setListening?.(false);
    if (!liveMode && !processing) setStatus("Online");
    // live mode: if a turn isn't in progress, keep the ear open for the next one
    if (liveMode && !processing) {
      setTimeout(() => { if (liveMode && !processing && !listening) startListening(); }, 500);
    }
  };

  micBtn.addEventListener("click", () => {
    window.ariaAvatar?.primeVoice?.();
    listening ? stopListening() : startListening();
  });
} else {
  // No speech recognition support (e.g. Firefox) — hide the mic button.
  micBtn.style.display = "none";
}

// ------------------------------------------------------------------ live conversation (hands-free)
const callBtn = el("callBtn");
async function startLive() {
  if (!SR) { toast("Live voice chat needs speech recognition — try Chrome or Edge.", "error"); return; }
  if (!getKey()) { openModal(); toast("Add your OpenRouter API key to start a live chat.", "error"); return; }
  liveMode = true;
  callBtn.classList.add("active", "calling");
  callBtn.title = "End live conversation";
  window.ariaAvatar?.primeVoice?.();
  if (!cameraOn) { try { await startCamera(); } catch {} } // scan + see the user
  toast("Live conversation on — just talk, I'm listening. Tap 📞 to end.", "info");
  if (!processing && !listening) startListening();
}
function stopLive() {
  liveMode = false;
  callBtn.classList.remove("active", "calling");
  callBtn.title = "Start live voice conversation";
  stopListening();
  window.ariaAvatar?.stopTalking?.();
  setStatus("Online");
}
callBtn?.addEventListener("click", () => { liveMode ? stopLive() : startLive(); });

// ------------------------------------------------------------------ init
function init() {
  try { loadSettings(); } catch (e) { /* storage blocked — handled by safe store */ }
  applyVoice(store.get(VOICE_STORE) !== "off"); // default: voice on
  window.ariaAvatar?.setVoiceName?.(store.get(VOICE_NAME_STORE) || "");
  // No fake greeting — the empty-state hint in #messages guides the user,
  // and the chat only ever shows real user/model exchanges.
}
init();
