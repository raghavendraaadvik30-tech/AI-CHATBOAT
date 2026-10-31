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
  g.addColorStop(0, "#2a2064");
  g.addColorStop(0.5, "#17123c");
  g.addColorStop(1, "#0c0a1e");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 256);
  // soft warm glow near the top-center, like a studio light spill
  const r = ctx.createRadialGradient(16, 70, 0, 16, 70, 150);
  r.addColorStop(0, "rgba(150,120,220,0.35)");
  r.addColorStop(1, "rgba(150,120,220,0)");
  ctx.fillStyle = r; ctx.fillRect(0, 0, 32, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

// studio 3-point rig for flattering, realistic skin
const keyLight = new THREE.DirectionalLight(0xfff0e0, 2.3);
keyLight.position.set(1.6, 1.9, 2.4); scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xbcd3ff, 0.75);
fillLight.position.set(-2.2, 0.4, 1.6); scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xeaf1ff, 1.9);
rimLight.position.set(-1.3, 1.7, -2.3); scene.add(rimLight);
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
let talking = false;
let currentViseme = null;
let mouthGain = 0;
let emotion = {};
let speakTimeout = null;
let primed = false, keepAlive = null;
let pendingFinish = null;
// lip-sync timing: track real speech pace from word-boundary events
let seqG = null, speechActive = false;
let charsPerMs = 0.05, anchorTime = 0, anchorChar = 0, lastBoundaryChar = -1, lastBoundaryTime = 0;

let gazeX = 0, gazeY = 0, gazeTX = 0, gazeTY = 0, nextGaze = 1.5;
let sacX = 0, sacY = 0;
let nextBlink = 1.2, blinkT = -1, blink = 0;
let browT = -1, nextBrow = 3;
let nod = 0;
let thinking = false, listening = false;
let microSmile = 0, nextSmile = 6;

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
  for (let i = 0; i < t.length; i++) {
    const two = t.substr(i, 2);
    if (two === "th") { seq.push({ v: "TH", start: i }); i++; continue; }
    if (two === "ch" || two === "sh") { seq.push({ v: "CH", start: i }); i++; continue; }
    if (two === "ng") { seq.push({ v: "nn", start: i }); i++; continue; }
    const v = charToViseme(t[i]);
    if (v) seq.push({ v, start: i });
    else if (/[.,!?;:]/.test(t[i])) seq.push({ v: "sil", start: i });
  }
  if (!seq.length) seq.push({ v: "sil", start: 0 });
  return seq;
}

function cleanForSpeech(text) {
  return text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "").trim();
}
function estDuration(text) {
  const words = cleanForSpeech(text).split(/\s+/).filter(Boolean).length;
  return Math.max(1200, words * 340 + 400);
}

// -------------------------------------------------------------- expression
function setEmotionFromText(text) {
  const ex = (text.match(/!/g) || []).length;
  const q = (text.match(/\?/g) || []).length;
  const smiley = /(:\)|:D|😊|😄|😀|🙂|😁|❤|😍|🎉|😎)/.test(text);
  if (ex >= 1 || smiley) {
    emotion = { browOuterUp_L: 0.3, browOuterUp_R: 0.3, browInnerUp: 0.15,
      eyeWide_L: 0.15, eyeWide_R: 0.15, mouthSmile_L: 0.28, mouthSmile_R: 0.28,
      cheekSquint_L: 0.2, cheekSquint_R: 0.2 };
  } else if (q >= 1) {
    emotion = { browInnerUp: 0.35, browOuterUp_L: 0.22, browOuterUp_R: 0.1,
      eyeWide_L: 0.12, eyeWide_R: 0.12, mouthSmile_L: 0.1, mouthSmile_R: 0.1 };
  } else {
    emotion = { mouthSmile_L: 0.14, mouthSmile_R: 0.14, cheekSquint_L: 0.08, cheekSquint_R: 0.08 };
  }
}

// -------------------------------------------------------------- lip-sync (rate-tracked)
// Instead of a fixed timer, the current viseme is derived each frame from an
// estimated character position. The estimate advances at charsPerMs, which is
// continuously corrected by real onboundary events -> lips track the voice.
function startSpeechSync(seq, dur) {
  seqG = seq;
  const totalChars = seq.length ? seq[seq.length - 1].start + 1 : 1;
  charsPerMs = Math.max(0.005, totalChars / Math.max(1, dur));
  anchorTime = performance.now(); anchorChar = 0;
  lastBoundaryChar = -1; lastBoundaryTime = 0;
  speechActive = true;
}
function onBoundary(charIndex) {
  const now = performance.now();
  if (lastBoundaryTime && charIndex > lastBoundaryChar) {
    const r = (charIndex - lastBoundaryChar) / (now - lastBoundaryTime); // chars/ms
    if (isFinite(r) && r > 0) charsPerMs = charsPerMs * 0.5 + r * 0.5;    // smooth
  }
  lastBoundaryChar = charIndex; lastBoundaryTime = now;
  anchorChar = charIndex; anchorTime = now; // re-anchor to the real position
}
function stopSpeechSync() { speechActive = false; seqG = null; currentViseme = null; }

// -------------------------------------------------------------- voices
let voices = [];
let preferredVoiceName = null;
try { preferredVoiceName = localStorage.getItem("aria.voiceName") || null; } catch {}
function refreshVoices() { try { voices = window.speechSynthesis.getVoices() || []; } catch { voices = []; } }
if (window.speechSynthesis) { refreshVoices(); window.speechSynthesis.onvoiceschanged = refreshVoices; }

const FEMALE_RE = /female|zira|aria|jenny|samantha|karen|moira|tessa|victoria|susan|fiona|hazel|serena|catherine|amelie/i;

function pickVoice() {
  if (!voices.length) refreshVoices();
  // 1) exact user choice
  if (preferredVoiceName) {
    const exact = voices.find((v) => v.name === preferredVoiceName);
    if (exact) return exact;
  }
  // 2) automatic -> prefer a MALE English voice
  const male = ["Google UK English Male", "Microsoft David", "Microsoft Mark", "Microsoft Guy",
    "Daniel", "Alex", "Fred", "Rishi", "Aaron", "Arthur", "Oliver", "Thomas"];
  for (const name of male) { const v = voices.find((x) => x.name && x.name.includes(name)); if (v) return v; }
  return voices.find((v) => /^en/i.test(v.lang) && /male|david|mark|daniel|alex|fred|guy|oliver|thomas/i.test(v.name) && !FEMALE_RE.test(v.name))
    || voices.find((v) => /^en/i.test(v.lang)) || voices[0] || null;
}
function voicePitchFor(v) { return v && FEMALE_RE.test(v.name) ? 1.12 : 0.95; }

// -------------------------------------------------------------- speak
// Unlock speech during a real user gesture. Browsers (esp. Chrome/Safari)
// often refuse to speak later — after an async fetch — unless synthesis was
// kicked off from a genuine interaction first. Call this from a click.
function primeVoice() {
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

function cancelSpeak() {
  stopSpeechSync();
  stopKeepAlive();
  if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  talking = false; currentViseme = null;
  if (pendingFinish) { const f = pendingFinish; pendingFinish = null; f(); } // resolve an interrupted turn
}

function speak(text) {
  cancelSpeak();
  const seq = buildVisemeSeq(text);
  setEmotionFromText(text);
  const dur = estDuration(text);
  const ss = window.speechSynthesis;

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      pendingFinish = null;
      stopSpeechSync(); stopKeepAlive();
      if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
      talking = false; currentViseme = null;
      resolve();
    };
    pendingFinish = finish;

    const canSpeak = voiceOn && ss && window.SpeechSynthesisUtterance;
    // drive the mouth immediately so lips move even if audio lags/fails
    talking = true;
    startSpeechSync(seq, dur);

    if (canSpeak) {
      const u = new SpeechSynthesisUtterance(cleanForSpeech(text) || " ");
      const v = pickVoice(); if (v) u.voice = v;
      u.rate = 1.0; u.pitch = voicePitchFor(v); u.volume = 1.0;
      u.onstart = () => { talking = true; if (!speechActive) startSpeechSync(seq, dur); };
      u.onboundary = (e) => { if (typeof e.charIndex === "number") onBoundary(e.charIndex); };
      u.onend = finish;
      u.onerror = finish;
      try {
        ss.resume();              // clear any paused state
        ss.speak(u);
        // Chrome goes silent on long utterances (~15s) — nudge it awake.
        keepAlive = setInterval(() => { try { ss.pause(); ss.resume(); } catch {} }, 9000);
      } catch { /* mouth still animates via scheduler */ }
      // safety net if onend/onerror never fire (known Chrome quirk)
      speakTimeout = setTimeout(finish, dur + 8000);
    } else {
      speakTimeout = setTimeout(finish, dur);
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
  dist *= 1.45;
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

    // emotion / resting expression
    for (const [k, v] of Object.entries(emotion)) setT(k, v);
    setT("browInnerUp", 0.05 + 0.03 * Math.sin(t * 0.7));

    // attentive listening pose — engaged, brows up, looking at you
    if (listening) {
      setT("browOuterUp_L", 0.18); setT("browOuterUp_R", 0.18); setT("browInnerUp", 0.2);
      setT("eyeWide_L", 0.12); setT("eyeWide_R", 0.12);
      setT("mouthSmile_L", 0.12); setT("mouthSmile_R", 0.12);
    }
    // thinking — a touch of concentration
    if (thinking) { setT("browInnerUp", 0.22); setT("browDown_L", 0.1); setT("browDown_R", 0.1); }

    // spontaneous warm micro-smile now and then
    nextSmile -= dt;
    if (nextSmile <= 0 && !thinking) { microSmile = 1; nextSmile = 7 + Math.random() * 8; }
    microSmile = Math.max(0, microSmile - dt * 0.4);
    const sm = Math.sin(Math.min(1, microSmile) * Math.PI) * 0.18;
    setT("mouthSmile_L", sm); setT("mouthSmile_R", sm);
    setT("cheekSquint_L", sm * 0.6); setT("cheekSquint_R", sm * 0.6);

    // blink timing
    nextBlink -= dt;
    if (blinkT < 0 && nextBlink <= 0) { blinkT = 0; nextBlink = 2 + Math.random() * 4; }
    blink = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      const dur = 0.18;
      blink = blinkT < dur / 2 ? blinkT / (dur / 2) : 1 - (blinkT - dur / 2) / (dur / 2);
      blink = Math.max(0, Math.min(1, blink));
      if (blinkT >= dur) blinkT = -1;
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
      sacX = (Math.random() * 2 - 1) * 0.22;
      sacY = (Math.random() * 2 - 1) * 0.16;
      nextGaze = 0.7 + Math.random() * 2.2;
    }
    gazeTX = Math.max(-1, Math.min(1, px * 0.7 + sacX));
    gazeTY = Math.max(-1, Math.min(1, py * 0.5 + sacY));
    if (thinking) { gazeTX = -0.45 + 0.1 * Math.sin(t * 1.3); gazeTY = -0.5; } // glance up & away
    else if (listening) { gazeTX = px * 0.4; gazeTY = py * 0.3; }              // stay on the user
    gazeX += (gazeTX - gazeX) * Math.min(1, dt * 10);
    gazeY += (gazeTY - gazeY) * Math.min(1, dt * 10);
    applyGaze();

    // derive the current viseme from the live-estimated speech position
    if (speechActive && seqG && seqG.length) {
      const est = anchorChar + (performance.now() - anchorTime) * charsPerMs;
      let vi = 0;
      for (let i = 0; i < seqG.length; i++) { if (seqG[i].start <= est) vi = i; else break; }
      currentViseme = VISEMES[seqG[vi].v] || VISEMES.sil;
    }

    // mouth: lip-sync viseme, or procedural fallback
    const speaking = talking || currentViseme;
    mouthGain += ((speaking ? 1 : 0) - mouthGain) * Math.min(1, dt * 12);
    if (currentViseme) {
      for (const [k, v] of Object.entries(currentViseme)) setT(k, v * mouthGain);
    } else if (talking) {
      const open = 0.1 + 0.16 * (0.5 + 0.5 * Math.sin(t * 13)) + 0.07 * Math.sin(t * 21 + 1);
      setT("jawOpen", open * mouthGain);
      setT("mouthFunnel", 0.1 * (0.5 + 0.5 * Math.sin(t * 8)) * mouthGain);
    }

    // smooth most influences toward target (time-constant ~45ms)
    const k = 1 - Math.exp(-dt / 0.045);
    for (let i = 0; i < influences.length; i++) {
      influences[i] += (targets[i] - influences[i]) * k;
    }

    // crisp blink: write directly so the 0.18s pulse is fully visible
    const bL = idx("eyeBlink_L"), bR = idx("eyeBlink_R");
    if (bL >= 0) influences[bL] = blink;
    if (bR >= 0) influences[bR] = blink;
  }

  // smooth pointer
  px += (tpx - px) * Math.min(1, dt * 3.5);
  py += (tpy - py) * Math.min(1, dt * 3.5);

  // head: breathing + layered idle sway + turn toward the pointer + nods
  if (faceRoot) {
    const speakingNow = talking || currentViseme;
    nod += ((speakingNow ? 1 : 0) - nod) * Math.min(1, dt * 4);
    const idleY = 0.045 * Math.sin(t * 0.5) + 0.02 * Math.sin(t * 0.17 + 1);
    const idleX = 0.028 * Math.sin(t * 0.63 + 1) + 0.012 * Math.sin(t * 0.23);
    faceRoot.rotation.y = baseRot.y + idleY + px * 0.22;
    faceRoot.rotation.x = baseRot.x + idleX + py * 0.13 + nod * 0.03 * Math.sin(t * 6.5);
    const tiltZ = (listening ? 0.09 : 0) + (thinking ? 0.06 : 0);
    faceRoot.rotation.z = baseRot.z + 0.014 * Math.sin(t * 0.4) - px * 0.03 + tiltZ;
    faceRoot.position.y = basePos.y + 0.004 * Math.sin(t * 1.1); // breathing
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
  primeVoice,
  startTalking() { cancelSpeak(); talking = true; },
  stopTalking() { cancelSpeak(); },
  setVoice(on) { voiceOn = !!on; if (!on) { try { window.speechSynthesis.cancel(); } catch {} } },
  setThinking(on) { thinking = !!on; },
  setListening(on) { listening = !!on; },
  listVoices() { refreshVoices(); return voices.map((v) => ({ name: v.name, lang: v.lang, default: !!v.default })); },
  setVoiceName(name) { preferredVoiceName = name || null; },
  get voiceOn() { return voiceOn; },
  get ttsSupported() { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); },
};
