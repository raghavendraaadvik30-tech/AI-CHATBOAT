// ========================================================================
// Aria — realistic 3D avatar engine (Three.js) with ARKit 52 blendshapes
//
// Renders a real human face scan (three.js `facecap.glb`) and drives the
// full ARKit blendshape set for lifelike behaviour:
//   • real lip-sync  — words -> viseme mouth shapes, timed to real speech
//   • eyebrows       — idle raises + emotion-driven brow shapes
//   • eyes           — crisp blinking + random saccades (darting gaze)
//   • expression     — emotion inferred from the reply
//   • head           — breathing, gentle sway, nods while speaking
//
// NOTE: facecap morph names use `_L` / `_R` suffixes (e.g. eyeBlink_L),
// not camelCase Left/Right. Getting this wrong is why blinks did nothing.
//
// Public API (window.ariaAvatar):
//   speak(text) -> Promise | startTalking() | stopTalking() | setVoice(bool)
// ========================================================================

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const BASIS_PATH = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/";
const MODEL_URL = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/facecap.glb";

const container = document.getElementById("avatarCanvas");
const loaderEl = document.getElementById("avatarLoader");
const loaderText = document.getElementById("loaderText");

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = makeStudioBackdrop(); // opaque gradient -> cohesive + lets bloom work

const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
camera.position.set(0, 0.06, 2.4);

function makeStudioBackdrop() {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#3a2c6b");
  g.addColorStop(0.5, "#1b1640");
  g.addColorStop(1, "#0d0a20");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 256);
  // warm studio light spill near the top-centre for lifelike skin tones
  const r = ctx.createRadialGradient(16, 64, 0, 16, 64, 160);
  r.addColorStop(0, "rgba(255,196,150,0.33)");
  r.addColorStop(0.5, "rgba(170,130,225,0.22)");
  r.addColorStop(1, "rgba(170,130,225,0)");
  ctx.fillStyle = r; ctx.fillRect(0, 0, 32, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

// studio 3-point rig for flattering, realistic skin
const keyLight = new THREE.DirectionalLight(0xffe9d2, 2.5);
keyLight.position.set(1.6, 1.9, 2.4); scene.add(keyLight);
const warmFront = new THREE.PointLight(0xffd9b3, 0.5, 8);
warmFront.position.set(0, 0.2, 2.6); scene.add(warmFront);
const fillLight = new THREE.DirectionalLight(0xbcd3ff, 0.75);
fillLight.position.set(-2.2, 0.4, 1.6); scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xeaf1ff, 1.9);
rimLight.position.set(-1.3, 1.7, -2.3); scene.add(rimLight);
// soft sky/ground bounce so shadows under chin and nose stay natural
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x8a5a44, 0.35));
const topLight = new THREE.DirectionalLight(0xffffff, 0.5);
topLight.position.set(0, 3, 0.5); scene.add(topLight);

// cinematic post-processing: subtle bloom for realistic catchlights + rim glow
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.5, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- state
let head = null, influences = null, targets = null;
const nameToIndex = {};
let faceRoot = null;
const baseRot = new THREE.Euler();
const basePos = new THREE.Vector3();
const clock = new THREE.Clock();

let voiceOn = true;
try { if (localStorage.getItem("aria.voice") === "off") voiceOn = false; } catch {}
let preferredLanguage = "en-IN";
try { preferredLanguage = localStorage.getItem("aria.language") || "en-IN"; } catch {}
let talking = false;
let currentViseme = null;
let mouthGain = 0;
let emotion = {};
let speakTimeout = null;
let primed = false, keepAlive = null;
let pendingFinish = null;
let speechGeneration = 0;
let audioContext = null;
let audioSource = null;
let speechAnalyser = null;
let analyserData = null;
let cloudAudioActive = false;
let audioEnergy = 0;
// lip-sync timing: track real speech pace from word-boundary events
let seqG = null, speechActive = false;
let charsPerMs = 0.05, anchorTime = 0, anchorChar = 0, lastBoundaryChar = -1, lastBoundaryTime = 0;

let gazeX = 0, gazeY = 0, gazeTX = 0, gazeTY = 0, nextGaze = 1.5;
let sacX = 0, sacY = 0;
let headPX = 0, headPY = 0;
let nextBlink = 1.2, blinkT = -1, blink = 0;
let blinkProfile = { close: 0.075, hold: 0.025, open: 0.14, left: 1, right: 0.97 };
let doubleBlinkPending = false;
let followUpBlink = false;
let browT = -1, nextBrow = 3;
let nod = 0;
let gestureNod = 0, gestureTilt = 0, gestureBrow = 0;
let lastSpeechGestureAt = 0;
let boundaryCount = 0;
let emotionGain = 0, emotionTarget = 0;
let thinking = false, listening = false;
let microSmile = 0, nextSmile = 6;
let prevEnergy = 0;

// pointer tracking — she looks toward your cursor (big "alive" boost)
let px = 0, py = 0, tpx = 0, tpy = 0;
window.addEventListener("pointermove", (e) => {
  tpx = (e.clientX / window.innerWidth) * 2 - 1;
  tpy = (e.clientY / window.innerHeight) * 2 - 1;
});
const camBase = new THREE.Vector3();
const lookAt = new THREE.Vector3();

function idx(n) { return n in nameToIndex ? nameToIndex[n] : -1; }
function setT(n, v) { const i = idx(n); if (i >= 0) targets[i] = Math.max(targets[i], v); }
function setTExact(n, v) { const i = idx(n); if (i >= 0) targets[i] = v; }

// ---------------------------------------------------------------- visemes
// ARKit mouth shapes (correct facecap names with _L/_R).
const VISEMES = {
  sil: {},
  PP: { mouthClose: 0.22, mouthPress_L: 0.3, mouthPress_R: 0.3 },
  FF: { mouthRollLower: 0.3, mouthFunnel: 0.12, jawOpen: 0.06, mouthLowerDown_L: 0.15, mouthLowerDown_R: 0.15 },
  TH: { jawOpen: 0.12, tongueOut: 0.25 },
  DD: { jawOpen: 0.14, mouthStretch_L: 0.1, mouthStretch_R: 0.1 },
  kk: { jawOpen: 0.17 },
  CH: { mouthFunnel: 0.32, mouthPucker: 0.22, jawOpen: 0.1 },
  SS: { jawOpen: 0.07, mouthStretch_L: 0.2, mouthStretch_R: 0.2, mouthClose: 0.08 },
  nn: { jawOpen: 0.1, mouthStretch_L: 0.08, mouthStretch_R: 0.08 },
  RR: { mouthFunnel: 0.3, mouthPucker: 0.16, jawOpen: 0.12 },
  aa: { jawOpen: 0.52, mouthFunnel: 0.05 },
  E:  { jawOpen: 0.26, mouthStretch_L: 0.26, mouthStretch_R: 0.26, mouthSmile_L: 0.1, mouthSmile_R: 0.1 },
  I:  { jawOpen: 0.16, mouthSmile_L: 0.26, mouthSmile_R: 0.26, mouthStretch_L: 0.2, mouthStretch_R: 0.2 },
  O:  { jawOpen: 0.36, mouthFunnel: 0.42, mouthPucker: 0.2 },
  U:  { jawOpen: 0.2, mouthPucker: 0.5, mouthFunnel: 0.3 },
};

function charToViseme(c) {
  switch (c) {
    case "a": return "aa";
    case "e": return "E";
    case "i": case "y": return "I";
    case "o": return "O";
    case "u": case "w": case "q": return "U";
    case "b": case "p": case "m": return "PP";
    case "f": case "v": return "FF";
    case "t": case "d": case "n": case "l": return "DD";
    case "k": case "g": case "c": return "kk";
    case "s": case "z": case "x": return "SS";
    case "r": return "RR";
    case "j": return "CH";
    case "h": return "aa";
    case " ": case "\n": case "\t": return "sil";
    default: return null;
  }
}

function buildVisemeSeq(text) {
  const t = text.toLowerCase();
  const seq = [];
  const kannadaMap = {
    "ಅ":"aa", "ಆ":"aa", "ಾ":"aa",
    "ಇ":"I", "ಈ":"I", "ಿ":"I", "ೀ":"I", "ಐ":"I", "ೈ":"I",
    "ಎ":"E", "ಏ":"E", "ೆ":"E", "ೇ":"E",
    "ಉ":"U", "ಊ":"U", "ು":"U", "ೂ":"U",
    "ಒ":"O", "ಓ":"O", "ಔ":"O", "ೊ":"O", "ೋ":"O", "ೌ":"O",
    "ಪ":"PP", "ಫ":"PP", "ಬ":"PP", "ಭ":"PP", "ಮ":"PP",
    "ಕ":"kk", "ಖ":"kk", "ಗ":"kk", "ಘ":"kk", "ಙ":"kk",
    "ಚ":"CH", "ಛ":"CH", "ಜ":"CH", "ಝ":"CH", "ಞ":"CH",
    "ತ":"DD", "ಥ":"DD", "ದ":"DD", "ಧ":"DD", "ನ":"nn",
    "ಟ":"DD", "ಠ":"DD", "ಡ":"DD", "ಢ":"DD", "ಣ":"nn",
    "ಲ":"DD", "ಳ":"DD", "ರ":"RR", "ಯ":"I", "ವ":"U",
    "ಸ":"SS", "ಶ":"CH", "ಷ":"CH", "ಹ":"aa", "ಂ":"nn",
  };

  for (let i = 0; i < t.length; i++) {
    const char = t[i];
    const kannada = kannadaMap[char];
    if (kannada) {
      seq.push({ v: kannada, start: i });
      // Kannada consonants carry a short inherent /a/ unless followed by a
      // vowel sign or virama. This transition makes native words read better.
      if (/[ಕ-ಹ]/.test(char) && !/[ಾ-ೌ್]/.test(t[i + 1] || "")) seq.push({ v: "aa", start: i + 0.55 });
      continue;
    }
    if (char === "್") { seq.push({ v: "sil", start: i }); continue; }

    const two = t.substr(i, 2);
    if (two === "th") { seq.push({ v: "TH", start: i }); i++; continue; }
    if (two === "ch" || two === "sh") { seq.push({ v: "CH", start: i }); i++; continue; }
    if (two === "ng") { seq.push({ v: "nn", start: i }); i++; continue; }
    const v = charToViseme(char);
    if (v) seq.push({ v, start: i });
    else if (/[.,!?;:।]/.test(char)) seq.push({ v: "sil", start: i });
  }
  if (!seq.length) seq.push({ v: "sil", start: 0 });
  return seq;
}

function cleanForSpeech(text) {
  return text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "").trim();
}
function estDuration(text) {
  const words = cleanForSpeech(text).split(/\s+/).filter(Boolean).length;
  const perWord = preferredLanguage.startsWith("kn") ? 390 : 330;
  return Math.max(1100, words * perWord + 350);
}

// -------------------------------------------------------------- expression
// Infer a human emotion from the reply and shape the whole face accordingly.
// Only ARKit morphs present in MANAGED are used, so they reset cleanly each
// frame. Small left/right asymmetry keeps expressions from looking mechanical.
function setEmotionFromText(text) {
  emotionTarget = 1;
  const t = text.toLowerCase();
  const ex = (text.match(/!/g) || []).length;
  const q = (text.match(/\?/g) || []).length;

  const affection = /(❤|😍|🥰|😘|love you|miss you|so sweet|dear friend|proud of you|care about you)/i.test(text);
  const joy = /(😊|😄|😀|🙂|😁|🥳|🎉|😎|haha|hehe|yay|great|awesome|wonderful|happy|glad|delighted|congratulations|congrats|excellent|amazing|fantastic|ಸಂತೋಷ|खुशी|மகிழ்ச்சி)/i.test(text);
  const surprise = /(😮|😲|😳|wow|whoa|oh my|no way|incredible|unbelievable|can'?t believe|really\?!?|surprising|ಆಶ್ಚರ್ಯ)/i.test(text);
  const sad = /(😢|😔|😞|🙁|i'?m sorry|unfortunately|sadly|apolog|regret|i can'?t|i cannot|not able to|that'?s sad|ಕ್ಷಮಿಸಿ|दुख)/i.test(text);
  const concern = /(please be careful|be careful|warning|caution|worried|concerned|that'?s a problem|there'?s an issue|an error|careful)/i.test(text);
  const playful = /(😉|😜|😏|😹|just kidding|kidding|teasing|hehe|wink)/i.test(text);

  const aL = 0.88 + Math.random() * 0.24;
  const aR = 0.88 + Math.random() * 0.24;

  if (affection) {
    emotion = { mouthSmile_L: 0.3 * aL, mouthSmile_R: 0.3 * aR, cheekSquint_L: 0.32, cheekSquint_R: 0.32,
      eyeSquint_L: 0.2, eyeSquint_R: 0.2, browInnerUp: 0.14 };
  } else if (surprise) {
    emotion = { eyeWide_L: 0.42, eyeWide_R: 0.42, browInnerUp: 0.3, browOuterUp_L: 0.45 * aL, browOuterUp_R: 0.45 * aR,
      jawOpen: 0.14, mouthSmile_L: 0.12, mouthSmile_R: 0.12 };
  } else if (joy || ex >= 2) {
    emotion = { mouthSmile_L: 0.44 * aL, mouthSmile_R: 0.44 * aR, cheekSquint_L: 0.32, cheekSquint_R: 0.32,
      eyeSquint_L: 0.16, eyeSquint_R: 0.16, browOuterUp_L: 0.22, browOuterUp_R: 0.22 };
  } else if (sad) {
    emotion = { browInnerUp: 0.42, mouthFrown_L: 0.2 * aL, mouthFrown_R: 0.2 * aR,
      eyeSquint_L: 0.12, eyeSquint_R: 0.12, mouthPress_L: 0.12, mouthPress_R: 0.12 };
  } else if (concern) {
    emotion = { browInnerUp: 0.32, browDown_L: 0.16, browDown_R: 0.16,
      mouthPress_L: 0.16, mouthPress_R: 0.16, eyeWide_L: 0.08, eyeWide_R: 0.08 };
  } else if (playful) {
    emotion = { mouthSmile_L: 0.4 * aL, mouthSmile_R: 0.18 * aR, browOuterUp_L: 0.32,
      cheekSquint_L: 0.26, eyeSquint_L: 0.14 }; // asymmetric smirk
  } else if (q >= 1) {
    emotion = { browInnerUp: 0.32, browOuterUp_L: 0.22 * aL, browOuterUp_R: 0.1 * aR,
      eyeWide_L: 0.1, eyeWide_R: 0.1, mouthSmile_L: 0.12, mouthSmile_R: 0.12 };
  } else if (ex >= 1) {
    emotion = { browOuterUp_L: 0.26, browOuterUp_R: 0.26, eyeWide_L: 0.14, eyeWide_R: 0.14,
      mouthSmile_L: 0.28 * aL, mouthSmile_R: 0.28 * aR, cheekSquint_L: 0.18, cheekSquint_R: 0.18 };
  } else {
    emotion = { mouthSmile_L: 0.15 * aL, mouthSmile_R: 0.15 * aR, cheekSquint_L: 0.08, cheekSquint_R: 0.08 };
  }
}

// -------------------------------------------------------------- lip-sync (rate-tracked)
// Instead of a fixed timer, the current viseme is derived each frame from an
// estimated character position. The estimate advances at charsPerMs, which is
// continuously corrected by real onboundary events -> lips track the voice.
function startSpeechSync(seq, dur) {
  seqG = seq;
  boundaryCount = 0;
  gestureNod = 0;
  gestureTilt = 0;
  gestureBrow = 0;
  const totalChars = seq.length ? seq[seq.length - 1].start + 1 : 1;
  charsPerMs = Math.max(0.005, totalChars / Math.max(1, dur));
  anchorTime = performance.now(); anchorChar = 0;
  lastBoundaryChar = -1; lastBoundaryTime = 0;
  speechActive = true;
}
function onBoundary(charIndex) {
  const now = performance.now();
  boundaryCount++;
  // Non-rhythmic phrase gestures: one restrained gesture at most every 550ms.
  if (now - lastSpeechGestureAt > 550 && Math.random() < 0.48) {
    lastSpeechGestureAt = now;
    const choice = Math.random();
    if (choice < 0.48) gestureNod = Math.min(1, gestureNod + 0.65);
    else if (choice < 0.76) gestureTilt = (Math.random() < 0.5 ? -1 : 1) * 0.42;
    else gestureBrow = 0.48;
    sacX = (Math.random() * 2 - 1) * 0.12;
    sacY = (Math.random() * 2 - 1) * 0.075;
  }
  if (lastBoundaryTime && charIndex > lastBoundaryChar) {
    const elapsed = now - lastBoundaryTime;
    const rate = (charIndex - lastBoundaryChar) / elapsed;
    if (isFinite(rate) && rate > 0 && rate < 0.2) charsPerMs = THREE.MathUtils.lerp(charsPerMs, rate, 0.35);
  }
  lastBoundaryChar = charIndex;
  lastBoundaryTime = now;
  anchorChar = charIndex;
  anchorTime = now;
}
function stopSpeechSync() {
  speechActive = false;
  seqG = null;
  currentViseme = null;
  emotionTarget = 0;
}

// -------------------------------------------------------------- voices
let voices = [];
let preferredVoiceName = null;
try { preferredVoiceName = localStorage.getItem("aria.voiceName") || null; } catch {}
function refreshVoices() { try { voices = window.speechSynthesis.getVoices() || []; } catch { voices = []; } }
if (window.speechSynthesis) { refreshVoices(); window.speechSynthesis.onvoiceschanged = refreshVoices; }

const FEMALE_RE = /female|zira|aria|jenny|samantha|karen|moira|tessa|victoria|susan|fiona|hazel|serena|catherine|amelie/i;

function pickVoice() {
  if (!voices.length) refreshVoices();
  const wanted = preferredLanguage.toLowerCase();
  const base = wanted.split("-")[0];
  const compatible = (voice) => (voice.lang || "").toLowerCase().startsWith(base);

  // Respect an explicit choice only if it matches the selected language.
  if (preferredVoiceName) {
    const exact = voices.find((voice) => voice.name === preferredVoiceName && compatible(voice));
    if (exact) return exact;
  }

  const languageVoices = voices.filter(compatible);
  const maleNames = /male|david|mark|daniel|alex|fred|guy|oliver|thomas|rishi|aaron|arthur/i;
  return languageVoices.find((voice) => maleNames.test(voice.name) && !FEMALE_RE.test(voice.name))
    || languageVoices.find((voice) => (voice.lang || "").toLowerCase() === wanted)
    || languageVoices[0]
    || voices.find((voice) => /^en/i.test(voice.lang || ""))
    || voices[0]
    || null;
}
function voicePitchFor(v) { return v && FEMALE_RE.test(v.name) ? 1.12 : 0.95; }

// -------------------------------------------------------------- speak
// Unlock speech during a real user gesture. Browsers (esp. Chrome/Safari)
// often refuse to speak later — after an async fetch — unless synthesis was
// kicked off from a genuine interaction first. Call this from a click.
function reportSpeechError(message) {
  window.dispatchEvent(new CustomEvent("aria-speech-error", { detail: message }));
}

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioContext = new AudioContextClass();
  }
  return audioContext;
}

function primeVoice() {
  const context = getAudioContext();
  try { context?.resume?.(); } catch {}
  const ss = window.speechSynthesis;
  if (!ss || !window.SpeechSynthesisUtterance) return;
  try {
    ss.resume();
    refreshVoices();
    if (!primed) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0; // silent warm-up
      ss.speak(u);
      primed = true;
    }
  } catch {}
}

function stopKeepAlive() { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } }

// Resume Web Audio on every genuine interaction. This prevents mobile Chrome
// and Safari from silently re-suspending neural speech after an async request.
document.addEventListener("pointerdown", () => {
  try { getAudioContext()?.resume?.(); } catch {}
}, { capture: true });

function stopCloudAudio() {
  cloudAudioActive = false;
  audioEnergy = 0;
  speechAnalyser = null;
  analyserData = null;
  if (!audioSource) return;
  const source = audioSource;
  audioSource = null;
  source.onended = null;
  try { source.stop(); } catch {}
  try { source.disconnect(); } catch {}
}

function cancelSpeak() {
  speechGeneration++;
  stopCloudAudio();
  stopSpeechSync();
  stopKeepAlive();
  if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  talking = false; currentViseme = null;
  if (pendingFinish) { const f = pendingFinish; pendingFinish = null; f(); } // resolve an interrupted turn
}

function speak(text) {
  cancelSpeak();
  const generation = speechGeneration;
  const spokenText = cleanForSpeech(text) || " ";
  const seq = buildVisemeSeq(spokenText);
  setEmotionFromText(spokenText);
  const dur = estDuration(spokenText);
  const ss = window.speechSynthesis;

  return new Promise((resolve) => {
    let done = false, started = false, startFb = null;
    const finish = () => {
      if (done) return; done = true;
      pendingFinish = null;
      if (startFb) { clearTimeout(startFb); startFb = null; }
      stopSpeechSync(); stopKeepAlive();
      if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
      talking = false; currentViseme = null;
      resolve();
    };
    pendingFinish = finish;

    // Start the lip clock at the ACTUAL audio onset so lips match from word one.
    const begin = () => {
      if (started) return; started = true;
      if (startFb) { clearTimeout(startFb); startFb = null; }
      talking = true;
      startSpeechSync(seq, dur);
    };

    const canSpeak = voiceOn && ss && window.SpeechSynthesisUtterance;
    talking = !canSpeak;

    if (canSpeak) {
      const u = new SpeechSynthesisUtterance(spokenText);
      const v = pickVoice(); if (v) u.voice = v;
      u.lang = preferredLanguage;
      u.rate = 1.0; u.pitch = voicePitchFor(v); u.volume = 1.0;
      u.onstart = () => { if (generation === speechGeneration) begin(); };
      u.onboundary = (e) => {
        if (generation === speechGeneration && typeof e.charIndex === "number") onBoundary(e.charIndex);
      };
      u.onend = () => { if (generation === speechGeneration) finish(); };
      u.onerror = (event) => {
        if (generation !== speechGeneration) return;
        reportSpeechError(`Browser voice failed${event?.error ? `: ${event.error}` : "."}`);
        finish();
      };
      try {
        ss.resume();
        ss.speak(u);
        keepAlive = setInterval(() => { try { ss.pause(); ss.resume(); } catch {} }, 9000);
      } catch { begin(); }
      startFb = setTimeout(begin, 650); // fallback only for browsers that omit onstart
      speakTimeout = setTimeout(finish, dur + 8000);
    } else {
      begin();
      speakTimeout = setTimeout(finish, dur);
    }
  });
}

async function speakAudio(text, audioBytes) {
  cancelSpeak();
  const generation = speechGeneration;
  const context = getAudioContext();
  if (!context) return speak(text);

  try { await context.resume(); } catch {}
  if (context.state !== "running") {
    reportSpeechError("Audio is blocked by the browser. Tap the 🔊 button once, then start the call again.");
    return speak(text);
  }
  let buffer;
  try {
    buffer = await context.decodeAudioData(audioBytes.slice(0));
  } catch {
    if (generation === speechGeneration) {
      reportSpeechError("The neural speech response could not be decoded; trying the browser voice.");
      return speak(text);
    }
    return;
  }
  if (generation !== speechGeneration) return;

  const spokenText = cleanForSpeech(text) || " ";
  const seq = buildVisemeSeq(spokenText);
  setEmotionFromText(spokenText);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pendingFinish = null;
      stopSpeechSync();
      stopCloudAudio();
      talking = false;
      currentViseme = null;
      resolve();
    };
    pendingFinish = finish;

    const source = context.createBufferSource();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(context.destination);
    source.onended = () => { if (generation === speechGeneration) finish(); };

    audioSource = source;
    speechAnalyser = analyser;
    analyserData = new Uint8Array(analyser.fftSize);
    cloudAudioActive = true;
    talking = true;
    startSpeechSync(seq, buffer.duration * 1000);
    try {
      source.start(0);
    } catch {
      reportSpeechError("Neural speech playback could not start. Tap 🔊 once and retry.");
      finish();
    }
  });
}

// ---------------------------------------------------------------- load model
function setLoader(msg, spinning = true) {
  if (!loaderEl) return;
  loaderText.textContent = msg;
  loaderEl.classList.toggle("error", !spinning);
}
const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(renderer);

new GLTFLoader()
  .setKTX2Loader(ktx2)
  .setMeshoptDecoder(MeshoptDecoder)
  .load(
    MODEL_URL,
    (gltf) => {
      faceRoot = gltf.scene.children[0];
      scene.add(faceRoot);
      head = findMorphMesh(faceRoot) || faceRoot.getObjectByName("mesh_2");
      if (head && head.morphTargetDictionary) {
        influences = head.morphTargetInfluences;
        targets = influences.slice();
        for (const [k, v] of Object.entries(head.morphTargetDictionary)) {
          nameToIndex[k.replace("blendShape1.", "")] = v;
        }
      }
      for (const n of MOUTH_NAMES) { const i = idx(n); if (i >= 0) mouthIdx.add(i); }
      baseRot.copy(faceRoot.rotation);
      basePos.copy(faceRoot.position);
      frameFace();
      if (loaderEl) loaderEl.remove();
      container.classList.add("ready"); // trigger CSS fade-in
      resize();
    },
    (ev) => { if (ev.total) setLoader(`Loading Aria… ${Math.round((ev.loaded / ev.total) * 100)}%`); },
    (err) => {
      console.error("Avatar load failed:", err);
      setLoader("Couldn't load the 3D avatar (check your internet connection, then reload).", false);
    }
  );

function findMorphMesh(root) {
  let found = null;
  root.traverse((o) => {
    if (o.isMesh && o.morphTargetInfluences && o.morphTargetDictionary) {
      if (!found || Object.keys(o.morphTargetDictionary).length > Object.keys(found.morphTargetDictionary).length) found = o;
    }
  });
  return found;
}
function frameFace() {
  if (!faceRoot) return;
  const box = new THREE.Box3().setFromObject(faceRoot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y);
  const fov = (camera.fov * Math.PI) / 180;
  let dist = (maxDim / 2) / Math.tan(fov / 2);
  dist *= 1.3; // closer portrait framing: the face fills the frame
  camera.position.set(center.x, center.y + size.y * 0.04, center.z + dist);
  camera.lookAt(center.x, center.y, center.z);
  camBase.copy(camera.position);
  lookAt.set(center.x, center.y, center.z);

  // give the skin a touch more life from the environment
  faceRoot.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if ("envMapIntensity" in m) m.envMapIntensity = 1.15;
        // soft, slightly satin skin instead of plastic shine
        if ("roughness" in m && m.name !== "eyes" && !/eye|teeth|tongue/i.test(m.name || o.name || "")) {
          m.roughness = Math.max(m.roughness ?? 0.6, 0.58);
          if ("sheen" in m) { m.sheen = 0.5; m.sheenRoughness = 0.5; m.sheenColor?.set?.(0xffc9b0); }
        }
        m.needsUpdate = true;
      }
    }
  });
}

// ---------------------------------------------------------------- resize
function resize() {
  const w = container.clientWidth || 1, h = container.clientHeight || 1;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- animation
function applyGaze() {
  if (gazeX > 0) { setTExact("eyeLookOut_L", gazeX * 0.6); setTExact("eyeLookIn_R", gazeX * 0.6); }
  else { setTExact("eyeLookIn_L", -gazeX * 0.6); setTExact("eyeLookOut_R", -gazeX * 0.6); }
  if (gazeY > 0) { setTExact("eyeLookUp_L", gazeY * 0.5); setTExact("eyeLookUp_R", gazeY * 0.5); }
  else { setTExact("eyeLookDown_L", -gazeY * 0.5); setTExact("eyeLookDown_R", -gazeY * 0.5); }
}

function beginBlink(isFollowUp = false) {
  blinkProfile = {
    close: 0.065 + Math.random() * 0.025,
    hold: 0.018 + Math.random() * 0.025,
    open: 0.12 + Math.random() * 0.055,
    left: 0.94 + Math.random() * 0.06,
    right: 0.94 + Math.random() * 0.06,
  };
  blinkT = 0;
  doubleBlinkPending = isFollowUp ? false : Math.random() < 0.14;
}

const MOUTH_NAMES = ["jawOpen", "mouthFunnel", "mouthPucker", "mouthClose", "mouthStretch_L", "mouthStretch_R",
  "mouthPress_L", "mouthPress_R", "mouthRollLower", "mouthRollUpper", "mouthLowerDown_L", "mouthLowerDown_R",
  "mouthUpperUp_L", "mouthUpperUp_R", "tongueOut"];
const mouthIdx = new Set();

const MANAGED = [
  "eyeBlink_L", "eyeBlink_R", "browInnerUp", "browOuterUp_L", "browOuterUp_R",
  "browDown_L", "browDown_R", "mouthSmile_L", "mouthSmile_R", "mouthFrown_L", "mouthFrown_R",
  "jawOpen", "mouthFunnel", "mouthPucker", "mouthClose", "mouthStretch_L", "mouthStretch_R",
  "mouthPress_L", "mouthPress_R", "mouthRollLower", "mouthLowerDown_L", "mouthLowerDown_R",
  "tongueOut", "eyeWide_L", "eyeWide_R", "eyeSquint_L", "eyeSquint_R",
  "cheekSquint_L", "cheekSquint_R", "noseSneer_L", "noseSneer_R",
  "eyeLookIn_L", "eyeLookOut_L", "eyeLookUp_L", "eyeLookDown_L",
  "eyeLookIn_R", "eyeLookOut_R", "eyeLookUp_R", "eyeLookDown_R",
];

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (influences) {
    for (const n of MANAGED) setTExact(n, 0);

    // expression envelope: quick human-like engagement, slower relaxed release
    const affectTarget = talking ? emotionTarget : 0;
    const affectSpeed = affectTarget > emotionGain ? 5.5 : 1.35;
    emotionGain += (affectTarget - emotionGain) * Math.min(1, dt * affectSpeed);
    for (const [k, v] of Object.entries(emotion)) setT(k, v * emotionGain);
    setT("browInnerUp", 0.05 + 0.03 * Math.sin(t * 0.7));

    gestureBrow = Math.max(0, gestureBrow - dt * 2.8);
    setT("browOuterUp_L", gestureBrow * 0.22);
    setT("browOuterUp_R", gestureBrow * 0.2);

    // attentive listening pose — engaged, brows up, looking at you
    if (listening && !talking) {
      setT("browOuterUp_L", 0.18); setT("browOuterUp_R", 0.18); setT("browInnerUp", 0.2);
      setT("eyeWide_L", 0.12); setT("eyeWide_R", 0.12);
      setT("mouthSmile_L", 0.12); setT("mouthSmile_R", 0.12);
    }
    // thinking — a touch of concentration
    if (thinking && !talking) { setT("browInnerUp", 0.22); setT("browDown_L", 0.1); setT("browDown_R", 0.1); }

    // spontaneous warm micro-smile now and then
    nextSmile -= dt;
    if (nextSmile <= 0 && !thinking) { microSmile = 1; nextSmile = 7 + Math.random() * 8; }
    microSmile = Math.max(0, microSmile - dt * 0.4);
    const sm = Math.sin(Math.min(1, microSmile) * Math.PI) * 0.18;
    setT("mouthSmile_L", sm); setT("mouthSmile_R", sm);
    setT("cheekSquint_L", sm * 0.6); setT("cheekSquint_R", sm * 0.6);

    // staged blink: fast close, tiny hold, slower opening, slight asymmetry
    nextBlink -= dt;
    if (blinkT < 0 && nextBlink <= 0) {
      beginBlink(followUpBlink);
      followUpBlink = false;
    }
    blink = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      const closeEnd = blinkProfile.close;
      const holdEnd = closeEnd + blinkProfile.hold;
      const end = holdEnd + blinkProfile.open;
      if (blinkT < closeEnd) blink = THREE.MathUtils.smoothstep(blinkT / closeEnd, 0, 1);
      else if (blinkT < holdEnd) blink = 1;
      else blink = 1 - THREE.MathUtils.smoothstep((blinkT - holdEnd) / blinkProfile.open, 0, 1);
      blink = THREE.MathUtils.clamp(blink, 0, 1);
      if (blinkT >= end) {
        blinkT = -1;
        if (doubleBlinkPending) {
          doubleBlinkPending = false;
          followUpBlink = true;
          nextBlink = 0.11 + Math.random() * 0.07;
        } else {
          nextBlink = (listening ? 3.2 : 2.2) + Math.random() * 4.2;
        }
      }
    }

    // spontaneous brow raise
    nextBrow -= dt;
    if (browT < 0 && nextBrow <= 0) { browT = 0; nextBrow = 4 + Math.random() * 6; }
    if (browT >= 0) {
      browT += dt; const d = 0.6;
      const b = Math.sin(Math.min(1, browT / d) * Math.PI) * 0.4;
      setT("browOuterUp_L", b); setT("browOuterUp_R", b); setT("browInnerUp", b * 0.6);
      if (browT >= d) browT = -1;
    }

    // gaze: track the pointer, plus small saccade jitter for life
    nextGaze -= dt;
    if (nextGaze <= 0) {
      const previousX = sacX, previousY = sacY;
      sacX = (Math.random() * 2 - 1) * 0.22;
      sacY = (Math.random() * 2 - 1) * 0.16;
      const relocation = Math.hypot(sacX - previousX, sacY - previousY);
      if (relocation > 0.22 && Math.random() < 0.42) nextBlink = Math.min(nextBlink, 0.12);
      nextGaze = 0.9 + Math.random() * 3.1;
    }
    gazeTX = Math.max(-1, Math.min(1, px * 0.7 + sacX));
    gazeTY = Math.max(-1, Math.min(1, py * 0.5 + sacY));
    if (thinking && !talking) { gazeTX = -0.32 + 0.06 * Math.sin(t * 1.3); gazeTY = -0.35; }
    else if (listening && !talking) { gazeTX = px * 0.32; gazeTY = py * 0.24; }
    gazeX += (gazeTX - gazeX) * Math.min(1, dt * 10);
    gazeY += (gazeTY - gazeY) * Math.min(1, dt * 10);
    applyGaze();

    // Real neural-audio amplitude drives jaw/lip strength. This closes the
    // mouth during actual pauses and opens it on voiced syllables.
    if (cloudAudioActive && speechAnalyser && analyserData) {
      speechAnalyser.getByteTimeDomainData(analyserData);
      let sum = 0;
      for (let i = 0; i < analyserData.length; i++) {
        const sample = (analyserData[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / analyserData.length);
      const targetEnergy = THREE.MathUtils.clamp((rms - 0.012) * 12, 0, 1);
      audioEnergy += (targetEnergy - audioEnergy) * Math.min(1, dt * 22);
    } else {
      audioEnergy += (0 - audioEnergy) * Math.min(1, dt * 12);
    }

    // derive the current viseme from the live-estimated speech position
    if (speechActive && seqG && seqG.length) {
      const est = anchorChar + (performance.now() - anchorTime) * charsPerMs;
      let vi = 0;
      for (let i = 0; i < seqG.length; i++) { if (seqG[i].start <= est) vi = i; else break; }
      const cur = VISEMES[seqG[vi].v] || VISEMES.sil;
      const nxt = seqG[vi + 1] ? (VISEMES[seqG[vi + 1].v] || VISEMES.sil) : cur;
      const span = seqG[vi + 1] ? Math.max(0.001, seqG[vi + 1].start - seqG[vi].start) : 1;
      // coarticulation: the lips start moving to the next sound before the
      // current one ends, which removes the robotic "snap" between shapes.
      const f = THREE.MathUtils.smoothstep((est - seqG[vi].start) / span, 0.45, 1) * 0.6;
      const blended = {};
      for (const key of new Set([...Object.keys(cur), ...Object.keys(nxt)])) {
        blended[key] = (cur[key] || 0) * (1 - f) + (nxt[key] || 0) * f;
      }
      currentViseme = blended;
    }

    // mouth: lip-sync viseme, or procedural fallback
    const speaking = talking || currentViseme;
    mouthGain += ((speaking ? 1 : 0) - mouthGain) * Math.min(1, dt * 12);
    const visemeEntries = currentViseme ? Object.entries(currentViseme) : [];
    if (visemeEntries.length) {
      const waveformGain = cloudAudioActive
        ? THREE.MathUtils.clamp(0.08 + audioEnergy * 1.45, 0.08, 1.15)
        : 1;
      for (const [k, v] of visemeEntries) setT(k, v * mouthGain * waveformGain);
    } else if (cloudAudioActive && audioEnergy > 0.015) {
      // Universal fallback for scripts without a detailed grapheme map.
      setT("jawOpen", audioEnergy * 0.42 * mouthGain);
      setT("mouthFunnel", audioEnergy * 0.08 * mouthGain);
    } else if (talking && !cloudAudioActive) {
      const open = 0.1 + 0.16 * (0.5 + 0.5 * Math.sin(t * 13)) + 0.07 * Math.sin(t * 21 + 1);
      setT("jawOpen", open * mouthGain);
      setT("mouthFunnel", 0.1 * (0.5 + 0.5 * Math.sin(t * 8)) * mouthGain);
    }

    // vocal emphasis: a sudden energy peak lifts the brows and nods slightly,
    // the way people punctuate stressed syllables.
    if (cloudAudioActive && audioEnergy - prevEnergy > 0.18 && audioEnergy > 0.45 && performance.now() - lastSpeechGestureAt > 450) {
      lastSpeechGestureAt = performance.now();
      gestureBrow = 0.55;
      if (Math.random() < 0.5) gestureNod = Math.min(1, gestureNod + 0.45);
    }
    prevEnergy = audioEnergy;
    if (talking) setT("browInnerUp", 0.06 + audioEnergy * 0.12);

    // genuine (Duchenne) smile: a real smile also lifts the cheeks and
    // narrows the eyes, and the nose wrinkles slightly.
    const smileNow = Math.max(0, (targets[idx("mouthSmile_L")] + targets[idx("mouthSmile_R")]) / 2) || 0;
    setT("cheekSquint_L", smileNow * 0.6); setT("cheekSquint_R", smileNow * 0.6);
    setT("eyeSquint_L", smileNow * 0.4); setT("eyeSquint_R", smileNow * 0.4);
    setT("noseSneer_L", smileNow * 0.1); setT("noseSneer_R", smileNow * 0.1);
    // a friendly resting smile while talking, softer at rest
    if (talking) { setT("mouthSmile_L", 0.1); setT("mouthSmile_R", 0.1); }
    else { setT("mouthSmile_L", 0.04); setT("mouthSmile_R", 0.04); }

    // mouth shapes follow fast (tight lip-sync); face/brows ease slower
    const kMouth = 1 - Math.exp(-dt / 0.026);
    const kFace = 1 - Math.exp(-dt / 0.06);
    for (let i = 0; i < influences.length; i++) {
      influences[i] += (targets[i] - influences[i]) * (mouthIdx.has(i) ? kMouth : kFace);
    }

    // crisp blink: write directly so the 0.18s pulse is fully visible
    const bL = idx("eyeBlink_L"), bR = idx("eyeBlink_R");
    // upper eyelids drop slightly when looking down (and rise when looking up)
    const lid = Math.max(0, -gazeY) * 0.3 + (thinking ? 0.06 : 0);
    if (bL >= 0) influences[bL] = Math.max(blink * blinkProfile.left, lid);
    if (bR >= 0) influences[bR] = Math.max(blink * blinkProfile.right, lid);
  }

  // smooth pointer
  px += (tpx - px) * Math.min(1, dt * 3.5);
  py += (tpy - py) * Math.min(1, dt * 3.5);
  // Eyes lead; the head follows more slowly and with a smaller range.
  headPX += (px - headPX) * Math.min(1, dt * 1.35);
  headPY += (py - headPY) * Math.min(1, dt * 1.2);

  // Head gestures are event-driven by speech boundaries. This avoids the
  // mechanical constant nod that made the previous animation look robotic.
  if (faceRoot) {
    const speakingNow = talking || currentViseme;
    nod += ((speakingNow ? 1 : 0) - nod) * Math.min(1, dt * 4);
    gestureNod = Math.max(0, gestureNod - dt * 2.6);
    gestureTilt *= Math.exp(-dt * 2.1);
    const nodBeat = Math.sin(gestureNod * Math.PI) * 0.055;
    const idleY = 0.026 * Math.sin(t * 0.43) + 0.012 * Math.sin(t * 0.19 + 1);
    const idleX = 0.018 * Math.sin(t * 0.51 + 1) + 0.008 * Math.sin(t * 0.21);
    faceRoot.rotation.y = baseRot.y + idleY + headPX * 0.11 + gestureTilt * 0.045;
    faceRoot.rotation.x = baseRot.x + idleX + headPY * 0.06 + nodBeat;
    const attentiveTilt = (listening && !talking ? 0.065 : 0) + (thinking && !talking ? 0.035 : 0);
    faceRoot.rotation.z = baseRot.z + 0.008 * Math.sin(t * 0.36) - headPX * 0.014 + attentiveTilt + gestureTilt * 0.018;
    faceRoot.position.y = basePos.y + 0.003 * Math.sin(t * 1.05);
  }

  // subtle camera parallax for depth (only once framed)
  if (faceRoot) {
    camera.position.x = camBase.x + px * 0.08;
    camera.position.y = camBase.y - py * 0.05;
    camera.position.z = camBase.z;
    camera.lookAt(lookAt);
  }

  composer.render();
}
renderer.setAnimationLoop(animate);

// ---------------------------------------------------------------- public API
window.ariaAvatar = {
  speak,
  speakAudio,
  primeVoice,
  startTalking() { cancelSpeak(); talking = true; },
  stopTalking() { cancelSpeak(); },
  setVoice(on) { voiceOn = !!on; if (!on) cancelSpeak(); },
  setLanguage(language) { preferredLanguage = language || "en-IN"; },
  setPhase(next) {
    thinking = next === "thinking";
    listening = next === "listening";
  },
  setThinking(on) { thinking = !!on; },
  setListening(on) { listening = !!on; },
  listVoices() { refreshVoices(); return voices.map((v) => ({ name: v.name, lang: v.lang, default: !!v.default })); },
  setVoiceName(name) { preferredVoiceName = name || null; },
  get voiceOn() { return voiceOn; },
  get ttsSupported() { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); },
};
window.dispatchEvent(new CustomEvent("aria-avatar-ready"));
