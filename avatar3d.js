// ========================================================================
// Aria — realistic 3D avatar engine (Three.js)
//
// Renders a real human face scan (three.js `facecap.glb`, which carries
// full ARKit blendshapes) and gives it life: image-based lighting for
// realistic skin, natural blinking, gentle breathing / head-sway, and
// jaw + mouth movement while Aria "talks".
//
// Exposes a tiny API on window.ariaAvatar:
//    startTalking(), stopTalking()
// so the chat logic (app.js) can sync the mouth to replies.
// ========================================================================

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const BASIS_PATH = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/";
const MODEL_URL = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/facecap.glb";

const container = document.getElementById("avatarCanvas");
const loader = document.getElementById("avatarLoader");
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

// image-based lighting -> realistic PBR skin, no external HDR needed
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

// a soft key light for a little extra definition / warmth
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1.2, 1.5, 2.5);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9bc4ff, 0.8);
rim.position.set(-2, 1, -1.5);
scene.add(rim);

// ---------------------------------------------------------------- state
let head = null;             // mesh carrying the morph targets
let influences = null;       // morphTargetInfluences array
let targets = null;          // per-index target weights (we lerp toward these)
let nameToIndex = {};        // "jawOpen" -> influence index
let faceRoot = null;         // group we gently rotate for idle motion
const baseRot = new THREE.Euler();
const basePos = new THREE.Vector3();

let talking = false;
let nextBlink = 1.5;
let blinkT = -1;             // >=0 while a blink is in progress
const clock = new THREE.Clock();

// map a bare ARKit name (e.g. "jawOpen") to its influence index.
// facecap keys look like "blendShape1.jawOpen".
function idx(name) {
  return name in nameToIndex ? nameToIndex[name] : -1;
}
function setTarget(name, v) {
  const i = idx(name);
  if (i >= 0) targets[i] = v;
}

// ---------------------------------------------------------------- load model
function setLoader(msg, spinning = true) {
  if (!loader) return;
  loaderText.textContent = msg;
  loader.classList.toggle("error", !spinning);
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

      head = faceRoot.getObjectByName("mesh_2") || findMorphMesh(faceRoot);
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
      if (loader) loader.remove();
      resize();
    },
    (ev) => {
      if (ev.total) setLoader(`Loading Aria… ${Math.round((ev.loaded / ev.total) * 100)}%`);
    },
    (err) => {
      console.error("Avatar load failed:", err);
      setLoader("Couldn't load the 3D avatar (check your internet connection, then reload).", false);
    }
  );

function findMorphMesh(root) {
  let found = null;
  root.traverse((o) => { if (!found && o.isMesh && o.morphTargetInfluences) found = o; });
  return found;
}

// frame the camera so the face nicely fills the view
function frameFace() {
  if (!faceRoot) return;
  const box = new THREE.Box3().setFromObject(faceRoot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y);
  const fov = (camera.fov * Math.PI) / 180;
  let dist = (maxDim / 2) / Math.tan(fov / 2);
  dist *= 1.45; // headroom
  camera.position.set(center.x, center.y + size.y * 0.04, center.z + dist);
  camera.lookAt(center.x, center.y, center.z);
}

// ---------------------------------------------------------------- resize
function resize() {
  const w = container.clientWidth || 1;
  const h = container.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- animation
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (influences) {
    // ---- resting micro-expression (friendly, alive) ----
    setTarget("mouthSmileLeft", 0.12);
    setTarget("mouthSmileRight", 0.12);
    setTarget("browInnerUp", 0.06 + 0.04 * Math.sin(t * 0.7));

    // ---- blinking ----
    nextBlink -= dt;
    if (blinkT < 0 && nextBlink <= 0) { blinkT = 0; nextBlink = 2 + Math.random() * 4; }
    let blink = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      const dur = 0.16;
      blink = blinkT < dur / 2 ? blinkT / (dur / 2) : 1 - (blinkT - dur / 2) / (dur / 2);
      blink = Math.max(0, Math.min(1, blink));
      if (blinkT >= dur) blinkT = -1;
    }
    setTarget("eyeBlinkLeft", blink);
    setTarget("eyeBlinkRight", blink);

    // ---- talking: jaw + lips driven by layered sine "speech" ----
    if (talking) {
      const open = 0.10 + 0.16 * (0.5 + 0.5 * Math.sin(t * 13)) + 0.07 * Math.sin(t * 21 + 1);
      setTarget("jawOpen", Math.max(0, Math.min(0.55, open)));
      setTarget("mouthFunnel", 0.10 * (0.5 + 0.5 * Math.sin(t * 8)));
      setTarget("mouthPucker", 0.06 * (0.5 + 0.5 * Math.sin(t * 11 + 2)));
    } else {
      setTarget("jawOpen", 0);
      setTarget("mouthFunnel", 0);
      setTarget("mouthPucker", 0);
    }

    // ---- ease every influence toward its target (smooth) ----
    const k = 1 - Math.pow(0.0001, dt); // frame-rate independent smoothing
    for (let i = 0; i < influences.length; i++) {
      influences[i] += (targets[i] - influences[i]) * k;
    }
  }

  // ---- idle breathing + head sway ----
  if (faceRoot) {
    faceRoot.rotation.y = baseRot.y + 0.05 * Math.sin(t * 0.5) + 0.02 * Math.sin(t * 0.17);
    faceRoot.rotation.x = baseRot.x + 0.03 * Math.sin(t * 0.63 + 1);
    faceRoot.rotation.z = baseRot.z + 0.015 * Math.sin(t * 0.4);
    faceRoot.position.y = basePos.y + 0.004 * Math.sin(t * 1.1); // breathing
  }

  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

// ---------------------------------------------------------------- public API
window.ariaAvatar = {
  startTalking() { talking = true; },
  stopTalking() { talking = false; },
};
