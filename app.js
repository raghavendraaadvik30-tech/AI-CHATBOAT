// ========================================================================
// Aria — chat, camera vision, bilingual speech and half-duplex live calls
// ========================================================================

const KEY_STORE = "aria.apiKey";
const MODEL_STORE = "aria.model";
const PERSONA_STORE = "aria.persona";
const VOICE_STORE = "aria.voice";
const VOICE_NAME_STORE = "aria.voiceName";
const LANGUAGE_STORE = "aria.language";
const TTS_MODE_STORE = "aria.ttsMode";
const TTS_MODEL_STORE = "aria.ttsModel";
const DEFAULT_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_PERSONA =
  "You are Aria, a warm, natural and concise AI companion. " +
  "When camera frames are attached, inspect them carefully before answering. " +
  "For counting, count only clearly visible items. For colours and objects, be precise. " +
  "If the view is unclear, say that briefly instead of guessing.";

const LANGUAGES = {
  "en-IN": {
    label: "English (India)",
    replyRule: "Reply in natural conversational English unless the user explicitly requests another language.",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
    online: "Online",
    preview: "Hello, this is how I sound.",
  },
  "kn-IN": {
    label: "ಕನ್ನಡ (Kannada)",
    replyRule: "Reply in natural conversational Kannada using Kannada script unless the user explicitly requests another language.",
    listening: "ಕೇಳುತ್ತಿದ್ದೇನೆ…",
    thinking: "ಯೋಚಿಸುತ್ತಿದ್ದೇನೆ…",
    speaking: "ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ…",
    online: "ಆನ್‌ಲೈನ್",
    preview: "ನಮಸ್ಕಾರ, ಇದು ನನ್ನ ಧ್ವನಿ.",
  },
};

const el = (id) => document.getElementById(id);
const messagesBox = el("messages");
const typing = el("typing");
const composer = el("composer");
const input = el("input");
const sendBtn = el("sendBtn");
const micBtn = el("micBtn");
const callBtn = el("callBtn");
const stopBtn = el("stopBtn");
const cameraBtn = el("cameraBtn");
const voiceBtn = el("voiceBtn");
const statusPill = el("statusPill");
const statusText = el("statusText");
const modal = el("modal");
const apiKeyInput = el("apiKey");
const modelInput = el("model");
const personaInput = el("persona");
const voiceSelect = el("voiceSelect");
const languageSelect = el("languageSelect");
const ttsModeSelect = el("ttsModeSelect");
const ttsModelInput = el("ttsModel");
const toastsBox = el("toasts");
const cameraEl = el("camera");
const camPreview = el("camPreview");

let history = [];
let phase = "idle"; // idle | listening | thinking | speaking | stopping
let liveMode = false;
let callSession = 0;
let turnSequence = 0;
let activeTurn = null;
let recognition = null;
let recognitionToken = 0;
let listenTimer = null;

// ------------------------------------------------------------------ safe store
const memStore = {};
let storageWorks = true;
const store = {
  get(key) {
    if (!storageWorks) return key in memStore ? memStore[key] : null;
    try { return localStorage.getItem(key); }
    catch { storageWorks = false; return key in memStore ? memStore[key] : null; }
  },
  set(key, value) {
    if (!storageWorks) { memStore[key] = value; return; }
    try { localStorage.setItem(key, value); }
    catch { storageWorks = false; memStore[key] = value; }
  },
};

function getKey() { return store.get(KEY_STORE) || ""; }
function getModel() { return store.get(MODEL_STORE) || DEFAULT_MODEL; }
function getPersona() { return store.get(PERSONA_STORE) || DEFAULT_PERSONA; }
function getTtsMode() { return store.get(TTS_MODE_STORE) || "auto"; }
function getTtsModel() { return store.get(TTS_MODEL_STORE) || DEFAULT_TTS_MODEL; }
function getLanguage() {
  const value = store.get(LANGUAGE_STORE) || "en-IN";
  return LANGUAGES[value] ? value : "en-IN";
}
function langCopy() { return LANGUAGES[getLanguage()]; }

// ------------------------------------------------------------------ settings
function listBrowserVoices() {
  const fromAvatar = window.ariaAvatar?.listVoices?.();
  if (fromAvatar?.length) return fromAvatar;
  try {
    return (window.speechSynthesis?.getVoices?.() || []).map((voice) => ({
      name: voice.name,
      lang: voice.lang,
      default: Boolean(voice.default),
    }));
  } catch { return []; }
}

function hasVoiceForLanguage(language) {
  const base = language.split("-")[0].toLowerCase();
  return listBrowserVoices().some((voice) => (voice.lang || "").toLowerCase().startsWith(base));
}

function populateVoices() {
  if (!voiceSelect) return;
  const chosen = store.get(VOICE_NAME_STORE) || "";
  const language = languageSelect?.value || getLanguage();
  const base = language.split("-")[0].toLowerCase();
  const all = listBrowserVoices();
  const sameLanguage = all.filter((voice) => (voice.lang || "").toLowerCase().startsWith(base));
  const shown = sameLanguage.length ? sameLanguage : all;

  voiceSelect.innerHTML = '<option value="">Automatic for selected language</option>';
  for (const voice of shown) {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang || "unknown"})`;
    voiceSelect.appendChild(option);
  }
  voiceSelect.value = shown.some((voice) => voice.name === chosen) ? chosen : "";
}

function loadSettings() {
  apiKeyInput.value = getKey();
  modelInput.value = getModel();
  personaInput.value = getPersona();
  languageSelect.value = getLanguage();
  ttsModeSelect.value = getTtsMode();
  ttsModelInput.value = getTtsModel();
  populateVoices();
}

function syncAvatarSettings() {
  const language = getLanguage();
  const voiceName = store.get(VOICE_NAME_STORE) || "";
  window.ariaAvatar?.setLanguage?.(language);
  window.ariaAvatar?.setVoiceName?.(voiceName);
  window.ariaAvatar?.setVoice?.(store.get(VOICE_STORE) !== "off");
  populateVoices();
}

function openModal() { loadSettings(); modal.hidden = false; }
function closeModal() { modal.hidden = true; }

el("settingsBtn").addEventListener("click", openModal);
el("closeModal").addEventListener("click", closeModal);
modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(); });

languageSelect.addEventListener("change", () => {
  populateVoices();
  window.ariaAvatar?.setLanguage?.(languageSelect.value);
});

voiceSelect.addEventListener("change", () => {
  window.ariaAvatar?.setLanguage?.(languageSelect.value);
  window.ariaAvatar?.setVoiceName?.(voiceSelect.value);
  window.ariaAvatar?.primeVoice?.();
  const preview = LANGUAGES[languageSelect.value]?.preview || LANGUAGES["en-IN"].preview;
  window.ariaAvatar?.speak?.(preview);
});

const saveBtn = el("saveSettings");
saveBtn.addEventListener("click", () => {
  const language = LANGUAGES[languageSelect.value] ? languageSelect.value : "en-IN";
  store.set(KEY_STORE, apiKeyInput.value.trim());
  store.set(MODEL_STORE, modelInput.value.trim() || DEFAULT_MODEL);
  store.set(PERSONA_STORE, personaInput.value.trim() || DEFAULT_PERSONA);
  store.set(LANGUAGE_STORE, language);
  store.set(TTS_MODE_STORE, ttsModeSelect.value || "auto");
  store.set(TTS_MODEL_STORE, ttsModelInput.value.trim() || DEFAULT_TTS_MODEL);
  document.documentElement.lang = language;
  store.set(VOICE_NAME_STORE, voiceSelect.value || "");
  syncAvatarSettings();

  const original = saveBtn.textContent;
  saveBtn.textContent = "Saved ✓";
  setTimeout(() => {
    saveBtn.textContent = original;
    closeModal();
    setPhase("idle");
    if (language === "kn-IN" && getTtsMode() === "browser" && !hasVoiceForLanguage(language)) {
      toast("No Kannada system voice was found. Select Automatic or OpenRouter neural voice for spoken Kannada.", "error", 9000);
    }
    if (!storageWorks) toast("Browser storage is blocked; these settings last only for this page session.", "error");
  }, 350);
});

try { window.speechSynthesis?.addEventListener?.("voiceschanged", populateVoices); } catch {}
window.addEventListener("aria-avatar-ready", syncAvatarSettings);

// ------------------------------------------------------------------ voice toggle
function applyVoice(on) {
  window.ariaAvatar?.setVoice?.(on);
  voiceBtn.textContent = on ? "🔊" : "🔇";
  voiceBtn.title = on ? "Voice on — click to mute" : "Voice off — click to unmute";
}
voiceBtn.addEventListener("click", () => {
  const next = store.get(VOICE_STORE) === "off";
  store.set(VOICE_STORE, next ? "on" : "off");
  applyVoice(next);
  if (next) window.ariaAvatar?.primeVoice?.();
});

// ------------------------------------------------------------------ phase/UI
function setPhase(next) {
  phase = next;
  document.body.dataset.phase = next;
  const copy = langCopy();
  const labels = {
    idle: copy.online,
    listening: copy.listening,
    thinking: copy.thinking,
    speaking: copy.speaking,
    stopping: copy.online,
  };
  statusText.textContent = labels[next] || copy.online;
  statusPill.classList.toggle("thinking", next === "thinking");
  statusPill.classList.toggle("listening", next === "listening");
  statusPill.classList.toggle("speaking", next === "speaking");
  stopBtn.hidden = next !== "thinking" && next !== "speaking";
  sendBtn.disabled = next === "thinking" || next === "speaking";
  window.ariaAvatar?.setPhase?.(next);
}

// ------------------------------------------------------------------ messages/toasts
function addMessage(role, text) {
  el("emptyHint")?.remove();
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "me" : "bot");
  div.textContent = text;
  messagesBox.appendChild(div);
  messagesBox.scrollTop = messagesBox.scrollHeight;
  return div;
}

function toast(message, type = "info", duration) {
  if (!toastsBox) return;
  const div = document.createElement("div");
  div.className = `toast ${type}`;
  div.textContent = message;
  toastsBox.appendChild(div);
  const life = duration || (type === "error" ? 7000 : 3500);
  const timer = setTimeout(dismiss, life);
  function dismiss() {
    clearTimeout(timer);
    div.classList.add("out");
    setTimeout(() => div.remove(), 250);
  }
  div.addEventListener("click", dismiss);
}

function showTyping(on) {
  typing.hidden = !on;
  if (on) messagesBox.scrollTop = messagesBox.scrollHeight;
}

function referer() {
  const origin = location.origin;
  return origin && origin !== "null" ? origin : "https://aria-avatar-chat.local";
}

// ------------------------------------------------------------------ camera vision
let camStream = null;
let cameraOn = false;
let cameraStarting = false;
let cameraGeneration = 0;
let cameraStartedByCall = false;

async function startCamera(owner = "user") {
  if (cameraOn) return true;
  if (cameraStarting) return false;
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Camera access is unavailable in this browser context.", "error");
    return false;
  }

  cameraStarting = true;
  const generation = ++cameraGeneration;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (generation !== cameraGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    camStream = stream;
    cameraEl.srcObject = stream;
    await cameraEl.play().catch(() => {});
    cameraOn = true;
    cameraStartedByCall = owner === "call";
    camPreview.hidden = false;
    cameraBtn.classList.add("active");
    cameraBtn.title = "Camera on — click to turn off";
    toast("Camera on.");
    return true;
  } catch {
    toast("Camera permission was denied or the camera is unavailable.", "error");
    return false;
  } finally {
    cameraStarting = false;
  }
}

function stopCamera() {
  cameraGeneration++;
  camStream?.getTracks().forEach((track) => track.stop());
  camStream = null;
  cameraEl.srcObject = null;
  cameraOn = false;
  cameraStartedByCall = false;
  camPreview.hidden = true;
  cameraBtn.classList.remove("active");
  cameraBtn.title = "Let Aria see you (camera)";
}

function captureFrame(maxWidth = 1024, quality = 0.88) {
  if (!cameraOn || !cameraEl.videoWidth) return null;
  const scale = Math.min(1, maxWidth / cameraEl.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cameraEl.videoWidth * scale);
  canvas.height = Math.round(cameraEl.videoHeight * scale);
  canvas.getContext("2d", { alpha: false }).drawImage(cameraEl, 0, 0, canvas.width, canvas.height);
  try { return canvas.toDataURL("image/jpeg", quality); }
  catch { return null; }
}

async function captureVisionFrames() {
  if (!cameraOn) return [];
  const first = captureFrame(768, 0.78);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const latest = captureFrame(1024, 0.88);
  return [first, latest].filter(Boolean);
}

cameraBtn.addEventListener("click", () => {
  if (cameraOn || cameraStarting) stopCamera();
  else startCamera("user");
});
window.addEventListener("pagehide", stopCamera);

// ------------------------------------------------------------------ request/turn coordinator
function buildVisionMessage(text, frames) {
  if (!frames.length) return { role: "user", content: text };
  const content = [
    {
      type: "text",
      text: `${text}\n\nThe attached camera images are chronological frames from the same live moment. Use the newest clear frame for colour/counting and compare both only when interpreting a visible gesture or motion.`,
    },
  ];
  frames.forEach((url, index) => content.push({
    type: "image_url",
    image_url: { url, detail: index === frames.length - 1 ? "high" : "low" },
  }));
  return { role: "user", content };
}

async function askOpenRouter(text, frames, turn) {
  const userHistoryMessage = { role: "user", content: text };
  const languageRule = LANGUAGES[turn.language]?.replyRule || LANGUAGES["en-IN"].replyRule;
  const requestMessages = [
    { role: "system", content: `${getPersona()}\n${languageRule}` },
    ...history,
    buildVisionMessage(text, frames),
  ];

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: turn.controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey()}`,
      "HTTP-Referer": referer(),
      "X-Title": "Aria Avatar Chat",
    },
    body: JSON.stringify({ model: getModel(), messages: requestMessages }),
  });

  if (!response.ok) {
    const textBody = await response.text();
    throw new Error(`API ${response.status}: ${textBody.slice(0, 220)}`);
  }

  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("The model returned an empty response.");
  if (turn.cancelled || turn.id !== activeTurn?.id) throw new DOMException("Cancelled", "AbortError");

  history.push(userHistoryMessage, { role: "assistant", content: reply });
  if (history.length > 20) history = history.slice(-20);
  return reply;
}

async function fetchCloudSpeech(text, turn) {
  const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
    method: "POST",
    signal: turn.controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey()}`,
      "HTTP-Referer": referer(),
      "X-Title": "Aria Avatar Chat",
    },
    body: JSON.stringify({
      model: getTtsModel(),
      input: text,
      voice: "Orus",
      response_format: "mp3",
      speed: 1,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Speech API ${response.status}: ${detail.slice(0, 180)}`);
  }
  return response.arrayBuffer();
}

function shouldUseCloudSpeech(language) {
  const mode = getTtsMode();
  return mode === "cloud" || (mode === "auto" && language === "kn-IN");
}

function typeOut(text, turn) {
  return new Promise((resolve) => {
    const div = addMessage("assistant", "");
    let index = 0;
    const step = Math.max(1, Math.round(text.length / 150));
    const timer = setInterval(() => {
      if (turn.cancelled || turn.controller.signal.aborted) {
        clearInterval(timer);
        div.textContent = text;
        resolve();
        return;
      }
      index += step;
      div.textContent = text.slice(0, index);
      messagesBox.scrollTop = messagesBox.scrollHeight;
      if (index >= text.length) {
        clearInterval(timer);
        div.textContent = text;
        resolve();
      }
    }, 18);
  });
}

async function runTurn(text) {
  const value = (text || "").trim();
  if (!value || activeTurn) return;
  if (!getKey()) {
    openModal();
    toast("Add your OpenRouter API key first.", "error");
    return;
  }

  stopRecognition(true);
  const session = callSession;
  const turn = {
    id: ++turnSequence,
    session,
    language: getLanguage(),
    controller: new AbortController(),
    cancelled: false,
  };
  activeTurn = turn;
  setPhase("thinking");
  showTyping(true);

  try {
    const frames = await captureVisionFrames();
    if (turn.cancelled || turn !== activeTurn) throw new DOMException("Cancelled", "AbortError");
    addMessage("user", frames.length ? `${value}  📷` : value);
    input.value = "";

    const reply = await askOpenRouter(value, frames, turn);
    if (turn.cancelled || turn !== activeTurn) throw new DOMException("Cancelled", "AbortError");

    let cloudAudio = null;
    if (shouldUseCloudSpeech(turn.language)) {
      try {
        cloudAudio = await fetchCloudSpeech(reply, turn);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        toast("Neural speech failed; trying the browser voice. " + (error.message || ""), "error", 9000);
      }
    }
    if (turn.cancelled || turn !== activeTurn) throw new DOMException("Cancelled", "AbortError");

    showTyping(false);
    setPhase("speaking");
    window.ariaAvatar?.setLanguage?.(turn.language);
    const speech = cloudAudio && window.ariaAvatar?.speakAudio
      ? window.ariaAvatar.speakAudio(reply, cloudAudio)
      : (window.ariaAvatar?.speak?.(reply) || Promise.resolve());
    await Promise.all([speech, typeOut(reply, turn)]);
  } catch (error) {
    if (error?.name !== "AbortError") toast(error.message || "The request failed.", "error", 10000);
  } finally {
    showTyping(false);
    if (activeTurn?.id === turn.id) activeTurn = null;
    setPhase("idle");
    if (liveMode && session === callSession) scheduleListening(700, session);
  }
}

function cancelActiveTurn({ resume = true } = {}) {
  const turn = activeTurn;
  if (!turn) return;
  setPhase("stopping");
  turn.cancelled = true;
  turn.controller.abort();
  window.ariaAvatar?.stopTalking?.();
  if (!resume || !liveMode) setPhase("idle");
}

stopBtn.addEventListener("click", () => cancelActiveTurn({ resume: true }));
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  window.ariaAvatar?.primeVoice?.();
  runTurn(input.value);
});

// ------------------------------------------------------------------ speech recognition
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;

function clearListenTimer() {
  if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
}

function stopRecognition(abort = false) {
  clearListenTimer();
  input.placeholder = "Say something to Aria…";
  const current = recognition;
  recognition = null;
  recognitionToken++;
  micBtn.classList.remove("listening");
  window.ariaAvatar?.setPhase?.(phase === "listening" ? "idle" : phase);
  if (!current) return;
  try { abort ? current.abort() : current.stop(); } catch {}
}

function scheduleListening(delay, session = callSession) {
  clearListenTimer();
  listenTimer = setTimeout(() => {
    listenTimer = null;
    if (liveMode && session === callSession && !activeTurn) startListening({ live: true, session });
  }, delay);
}

function startListening({ live = false, session = callSession } = {}) {
  if (!SpeechRecognitionApi || recognition || activeTurn) return;
  const rec = new SpeechRecognitionApi();
  const token = ++recognitionToken;
  recognition = rec;
  rec.lang = getLanguage();
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    if (recognition !== rec) return;
    micBtn.classList.add("listening");
    setPhase("listening");
  };
  rec.onresult = (event) => {
    if (recognition !== rec) return;
    let transcript = "";
    let final = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0]?.transcript || "";
      final ||= event.results[i].isFinal;
    }
    input.value = transcript.trim();
    if (!final || !input.value) return;
    const spoken = input.value;
    recognition = null;
    try { rec.stop(); } catch {}
    micBtn.classList.remove("listening");
    runTurn(spoken);
  };
  rec.onerror = (event) => {
    if (recognition !== rec) return;
    recognition = null;
    micBtn.classList.remove("listening");
    const fatal = event.error === "not-allowed" || event.error === "service-not-allowed";
    if (fatal) {
      toast("Microphone permission is required for live conversation.", "error");
      if (liveMode) stopLive();
    }
  };
  rec.onend = () => {
    input.placeholder = "Say something to Aria…";
    if (recognition === rec) recognition = null;
    micBtn.classList.remove("listening");
    if (live && liveMode && session === callSession && !activeTurn && token === recognitionToken) {
      scheduleListening(450, session);
    } else if (!activeTurn && !liveMode) {
      setPhase("idle");
    }
  };

  input.value = "";
  input.placeholder = LANGUAGES[getLanguage()]?.listening || "Listening…";
  try { rec.start(); }
  catch {
    recognition = null;
    micBtn.classList.remove("listening");
    if (live && liveMode) scheduleListening(600, session);
  }
}

micBtn.addEventListener("click", () => {
  window.ariaAvatar?.primeVoice?.();
  if (recognition) {
    stopRecognition(true);
    setPhase("idle");
  } else if (!activeTurn) {
    startListening({ live: false });
  }
});

// ------------------------------------------------------------------ half-duplex live conversation
async function startLive() {
  if (!SpeechRecognitionApi) {
    toast("Live voice conversation requires Chrome, Edge, or another browser with speech recognition.", "error");
    return;
  }
  if (!getKey()) {
    openModal();
    toast("Add your OpenRouter API key first.", "error");
    return;
  }

  liveMode = true;
  const session = ++callSession;
  callBtn.classList.add("active", "calling");
  callBtn.textContent = "📵";
  callBtn.title = "End live conversation";
  window.ariaAvatar?.primeVoice?.();

  if (!cameraOn) await startCamera("call");
  if (!liveMode || session !== callSession) return;
  toast("Live conversation started. The mic pauses while the avatar speaks, preventing echo.");
  startListening({ live: true, session });
}

function stopLive() {
  liveMode = false;
  callSession++;
  clearListenTimer();
  stopRecognition(true);
  cancelActiveTurn({ resume: false });
  window.ariaAvatar?.stopTalking?.();
  callBtn.classList.remove("active", "calling");
  callBtn.textContent = "📞";
  callBtn.title = "Start live voice conversation";
  if (cameraStartedByCall) stopCamera();
  setPhase("idle");
}

callBtn.addEventListener("click", () => { liveMode ? stopLive() : startLive(); });

// ------------------------------------------------------------------ init
function init() {
  loadSettings();
  document.documentElement.lang = getLanguage();
  applyVoice(store.get(VOICE_STORE) !== "off");
  syncAvatarSettings();
  setPhase("idle");
}
init();
