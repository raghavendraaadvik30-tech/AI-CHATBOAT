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
const GOOGLE_KEY_STORE = "aria.googleApiKey";
const GOOGLE_TTS_MODEL_STORE = "aria.googleTtsModel";
const DEFAULT_TTS_MODEL = "google/gemini-3.1-flash-tts-preview";
const DEFAULT_GOOGLE_TTS_MODEL = "gemini-3.1-flash-tts-preview";

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
const googleApiKeyInput = el("googleApiKey");
const modelInput = el("model");
const personaInput = el("persona");
const voiceSelect = el("voiceSelect");
const languageSelect = el("languageSelect");
const ttsModeSelect = el("ttsModeSelect");
const ttsModelInput = el("ttsModel");
const googleTtsModelInput = el("googleTtsModel");
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
function getGoogleKey() { return store.get(GOOGLE_KEY_STORE) || ""; }
function getModel() { return store.get(MODEL_STORE) || DEFAULT_MODEL; }
function getPersona() { return store.get(PERSONA_STORE) || DEFAULT_PERSONA; }
function getTtsMode() {
  const mode = store.get(TTS_MODE_STORE) || "auto";
  return mode === "cloud" ? "openrouter" : mode;
}
function getTtsModel() { return store.get(TTS_MODEL_STORE) || DEFAULT_TTS_MODEL; }
function getGoogleTtsModel() { return store.get(GOOGLE_TTS_MODEL_STORE) || DEFAULT_GOOGLE_TTS_MODEL; }
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
  googleApiKeyInput.value = getGoogleKey();
  modelInput.value = getModel();
  personaInput.value = getPersona();
  languageSelect.value = getLanguage();
  ttsModeSelect.value = getTtsMode() === "cloud" ? "openrouter" : getTtsMode();
  ttsModelInput.value = getTtsModel();
  googleTtsModelInput.value = getGoogleTtsModel();
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
  store.set(GOOGLE_KEY_STORE, googleApiKeyInput.value.trim());
  store.set(MODEL_STORE, modelInput.value.trim() || DEFAULT_MODEL);
  store.set(PERSONA_STORE, personaInput.value.trim() || DEFAULT_PERSONA);
  store.set(LANGUAGE_STORE, language);
  store.set(TTS_MODE_STORE, ttsModeSelect.value || "auto");
  store.set(TTS_MODEL_STORE, ttsModelInput.value.trim() || DEFAULT_TTS_MODEL);
  store.set(GOOGLE_TTS_MODEL_STORE, googleTtsModelInput.value.trim() || DEFAULT_GOOGLE_TTS_MODEL);
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
window.addEventListener("aria-speech-error", (event) => {
  toast(event.detail || "Speech playback failed.", "error", 10000);
});

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

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pcm16ToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav.buffer;
}

async function fetchGoogleSpeech(text, turn) {
  const key = getGoogleKey();
  if (!key) throw new Error("Google Gemini key is not configured");
  const model = encodeURIComponent(getGoogleTtsModel());
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal: turn.controller.signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Orus" } } },
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google speech ${response.status}: ${detail.slice(0, 180)}`);
  }
  const data = await response.json();
  const parts = data?.candidates?.flatMap((candidate) => candidate?.content?.parts || []) || [];
  const inline = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const payload = inline?.inlineData || inline?.inline_data;
  if (!payload?.data) throw new Error("Google speech returned no audio data");

  const bytes = base64ToBytes(payload.data);
  const mime = (payload.mimeType || payload.mime_type || "").toLowerCase();
  if (mime.includes("l16") || mime.includes("pcm")) {
    const rate = Number(mime.match(/rate[=;](\d+)/)?.[1] || 24000);
    return pcm16ToWav(bytes, rate, 1);
  }
  return bytes.buffer;
}

async function fetchOpenRouterSpeech(text, turn) {
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
    throw new Error(`OpenRouter speech ${response.status}: ${detail.slice(0, 180)}`);
  }
  return response.arrayBuffer();
}

async function fetchNeuralSpeech(text, turn) {
  const mode = getTtsMode();
  const providers = mode === "openrouter"
    ? [fetchOpenRouterSpeech, fetchGoogleSpeech]
    : [fetchGoogleSpeech, fetchOpenRouterSpeech];
  const errors = [];
  for (const provider of providers) {
    try {
      const audio = await provider(text, turn);
      return { audio, provider: provider === fetchGoogleSpeech ? "Google" : "OpenRouter" };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      errors.push(error.message || String(error));
    }
  }
  throw new Error(errors.join(" | "));
}

function shouldUseNeuralSpeech(language) {
  const mode = getTtsMode();
  if (mode === "browser") return language === "kn-IN" && !hasVoiceForLanguage(language);
  return mode === "google" || mode === "openrouter" || mode === "auto";
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

    let neuralSpeech = null;
    if (shouldUseNeuralSpeech(turn.language)) {
      try {
        neuralSpeech = await fetchNeuralSpeech(reply, turn);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        toast("Neural speech failed; trying the browser voice. " + (error.message || ""), "error", 10000);
      }
    }
    if (turn.cancelled || turn !== activeTurn) throw new DOMException("Cancelled", "AbortError");

    showTyping(false);
    setPhase("speaking");
    window.ariaAvatar?.setLanguage?.(turn.language);
    const speech = neuralSpeech?.audio && window.ariaAvatar?.speakAudio
      ? window.ariaAvatar.speakAudio(reply, neuralSpeech.audio)
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
  // A live call is expected to speak. Clear any remembered mute state.
  store.set(VOICE_STORE, "on");
  applyVoice(true);
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
