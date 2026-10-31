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
  "Keep replies concise, natural and human. Use a little personality and the occasional emoji.";

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
      addMessage(
        "assistant",
        "Heads up: your browser is blocking saved settings (this happens when the page is opened as a file://). " +
        "Your key works for this session, but to make it persist, run the app from a local web server — e.g. `python3 -m http.server` then open http://localhost:8000."
      );
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
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "me" : "bot");
  div.textContent = text;
  messagesBox.appendChild(div);
  messagesBox.scrollTop = messagesBox.scrollHeight;
  return div;
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
async function askOpenRouter(userText) {
  const key = getKey();
  if (!key) {
    openModal();
    addMessage("assistant", "Please add your OpenRouter API key in settings (⚙) first.");
    return;
  }

  history.push({ role: "user", content: userText });

  const payload = {
    model: getModel(),
    messages: [{ role: "system", content: getPersona() }, ...history],
  };

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
      addMessage("assistant", `⚠️ API error (${res.status}): ${errText.slice(0, 300)}`);
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
    addMessage("assistant", "⚠️ Network error: " + err.message);
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

// ------------------------------------------------------------------ submit
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addMessage("user", text);
  input.value = "";
  askOpenRouter(text);
});

// ------------------------------------------------------------------ init
function init() {
  try { loadSettings(); } catch (e) { /* storage blocked — handled by safe store */ }
  applyVoice(store.get(VOICE_STORE) !== "off"); // default: voice on
  // greeting
  addMessage(
    "assistant",
    "Hi, I'm Aria! 👋 Tap the ⚙ icon to add your OpenRouter API key, then let's chat."
  );
}
init();
