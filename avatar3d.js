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
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
camera.position.set(0, 0.06, 2.4);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1.2, 1.5, 2.5); scene.add(key);
const rim = new THREE.DirectionalLight(0x9bc4ff, 0.8);
rim.position.set(-2, 1, -1.5); scene.add(rim);

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
let schedTimer = null, speakTimeout = null, cursor = 0;

let gazeX = 0, gazeY = 0, gazeTX = 0, gazeTY = 0, nextGaze = 1.5;
let nextBlink = 1.2, blinkT = -1, blink = 0;
let browT = -1, nextBrow = 3;
let nod = 0;

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

// -------------------------------------------------------------- lip-sync scheduler
function stopScheduler() { if (schedTimer) { clearInterval(schedTimer); schedTimer = null; } }
function startScheduler(seq, dur) {
  stopScheduler();
  cursor = 0;
  const step = Math.max(55, Math.min(115, dur / Math.max(1, seq.length)));
  schedTimer = setInterval(() => {
    if (cursor >= seq.length) { currentViseme = VISEMES.sil; return; }
    currentViseme = VISEMES[seq[cursor].v] || VISEMES.sil;
    cursor++;
  }, step);
}
function resyncCursor(seq, charIndex) {
  for (let i = 0; i < seq.length; i++) if (seq[i].start >= charIndex) { cursor = i; return; }
}

// -------------------------------------------------------------- voices
let voices = [];
function refreshVoices() { try { voices = window.speechSynthesis.getVoices() || []; } catch { voices = []; } }
if (window.speechSynthesis) { refreshVoices(); window.speechSynthesis.onvoiceschanged = refreshVoices; }
function pickVoice() {
  if (!voices.length) refreshVoices();
  const pref = ["Google UK English Female", "Samantha", "Microsoft Zira", "Microsoft Aria",
    "Microsoft Jenny", "Google US English", "Karen", "Moira", "Tessa", "Victoria"];
  for (const name of pref) { const v = voices.find((x) => x.name && x.name.includes(name)); if (v) return v; }
  return voices.find((v) => /^en/i.test(v.lang) && /female|zira|aria|jenny|samantha/i.test(v.name))
    || voices.find((v) => /^en/i.test(v.lang)) || voices[0] || null;
}

// -------------------------------------------------------------- speak
function cancelSpeak() {
  stopScheduler();
  if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  talking = false; currentViseme = null;
}

function speak(text) {
  cancelSpeak();
  const seq = buildVisemeSeq(text);
  setEmotionFromText(text);
  const dur = estDuration(text);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      stopScheduler();
      if (speakTimeout) { clearTimeout(speakTimeout); speakTimeout = null; }
      talking = false; currentViseme = null;
      resolve();
    };
    const canSpeak = voiceOn && window.speechSynthesis && window.SpeechSynthesisUtterance;
    if (canSpeak) {
      const u = new SpeechSynthesisUtterance(cleanForSpeech(text) || " ");
      const v = pickVoice(); if (v) u.voice = v;
      u.rate = 1.0; u.pitch = 1.15; u.volume = 1.0;
      u.onstart = () => { talking = true; startScheduler(seq, dur); };
      u.onboundary = (e) => { if (typeof e.charIndex === "number") resyncCursor(seq, e.charIndex); };
      u.onend = finish; u.onerror = finish;
      try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); }
      catch { talking = true; startScheduler(seq, dur); }
      speakTimeout = setTimeout(finish, dur + 6000);
    } else {
      talking = true; startScheduler(seq, dur);
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
}

// ---------------------------------------------------------------- resize
function resize() {
  const w = container.clientWidth || 1, h = container.clientHeight || 1;
  renderer.setSize(w, h, false);
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

    // eye saccades
    nextGaze -= dt;
    if (nextGaze <= 0) {
      gazeTX = (Math.random() * 2 - 1) * 0.7;
      gazeTY = (Math.random() * 2 - 1) * 0.5;
      nextGaze = 0.8 + Math.random() * 2.5;
    }
    gazeX += (gazeTX - gazeX) * Math.min(1, dt * 10);
    gazeY += (gazeTY - gazeY) * Math.min(1, dt * 10);
    applyGaze();

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

  // head: breathing, sway, nods while speaking
  if (faceRoot) {
    const speakingNow = talking || currentViseme;
    nod += ((speakingNow ? 1 : 0) - nod) * Math.min(1, dt * 4);
    faceRoot.rotation.y = baseRot.y + 0.05 * Math.sin(t * 0.5) + 0.02 * Math.sin(t * 0.17);
    faceRoot.rotation.x = baseRot.x + 0.03 * Math.sin(t * 0.63 + 1) + nod * 0.03 * Math.sin(t * 6.5);
    faceRoot.rotation.z = baseRot.z + 0.015 * Math.sin(t * 0.4);
    faceRoot.position.y = basePos.y + 0.004 * Math.sin(t * 1.1);
  }

  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

// ---------------------------------------------------------------- public API
window.ariaAvatar = {
  speak,
  startTalking() { cancelSpeak(); talking = true; },
  stopTalking() { cancelSpeak(); },
  setVoice(on) { voiceOn = !!on; if (!on) { try { window.speechSynthesis.cancel(); } catch {} } },
  get voiceOn() { return voiceOn; },
};
