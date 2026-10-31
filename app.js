// ========================================================================
// Aria — AI Avatar Chat
// A small, dependency-free chat client for OpenRouter with an animated
// SVG avatar that blinks, breathes, and "talks" while responding.
// ========================================================================

const KEY_STORE = "aria.apiKey";
const MODEL_STORE = "aria.model";
const PERSONA_STORE = "aria.persona";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_PERSONA =
  "You are Aria, a warm, upbeat and friendly AI companion. " +
  "Keep replies concise, natural and human. Use a little personality and the occasional emoji.";

// ---- element refs ----
const el = (id) => document.getElementById(id);
const avatar = el("avatar");
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

// ------------------------------------------------------------------ settings
function loadSettings() {
  apiKeyInput.value = localStorage.getItem(KEY_STORE) || "";
  modelInput.value = localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL;
  personaInput.value = localStorage.getItem(PERSONA_STORE) || DEFAULT_PERSONA;
}
function getKey() { return localStorage.getItem(KEY_STORE) || ""; }
function getModel() { return localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL; }
function getPersona() { return localStorage.getItem(PERSONA_STORE) || DEFAULT_PERSONA; }

function openModal() { loadSettings(); modal.hidden = false; }
function closeModal() { modal.hidden = true; }

el("settingsBtn").addEventListener("click", openModal);
el("closeModal").addEventListener("click", closeModal);
el("saveSettings").addEventListener("click", () => {
  localStorage.setItem(KEY_STORE, apiKeyInput.value.trim());
  localStorage.setItem(MODEL_STORE, modelInput.value.trim() || DEFAULT_MODEL);
  localStorage.setItem(PERSONA_STORE, personaInput.value.trim() || DEFAULT_PERSONA);
  closeModal();
  setStatus("Online");
});
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

// ------------------------------------------------------------------ avatar fx
// Blink at random intervals
function scheduleBlink() {
  const delay = 2200 + Math.random() * 3500;
  setTimeout(() => {
    avatar.classList.add("blink");
    setTimeout(() => avatar.classList.remove("blink"), 300);
    scheduleBlink();
  }, delay);
}
function startTalking() { avatar.classList.add("talking"); }
function stopTalking() { avatar.classList.remove("talking"); }

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
        "HTTP-Referer": location.origin,
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
    startTalking();
    await typeOut(reply);
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
  loadSettings();
  scheduleBlink();
  // greeting
  addMessage(
    "assistant",
    "Hi, I'm Aria! 👋 Tap the ⚙ icon to add your OpenRouter API key, then let's chat."
  );
}
init();
