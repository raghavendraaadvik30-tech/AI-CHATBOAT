# Aria · AI Avatar Chat 🤖💬

An attractive **AI avatar chatbot** built with plain HTML, CSS, and JavaScript —
no build step. Aria is a **realistic 3D human face** (rendered with
[Three.js](https://threejs.org)) who **blinks**, **breathes**, sways gently, and
moves her **jaw and mouth** while she answers, powered by the
[OpenRouter](https://openrouter.ai) chat API.

![stack: html css js three.js](https://img.shields.io/badge/stack-HTML%20%7C%20CSS%20%7C%20JS%20%7C%20Three.js-8b5cf6)

## ✨ Features

- **Realistic 3D avatar** — a real human face scan (`facecap.glb`) driven by
  the full **ARKit 52-blendshape** set, lit with image-based lighting for
  lifelike skin. (No Ready Player Me dependency — that service shut down in
  Jan 2026; assets load from the reliable jsDelivr CDN.)
- **Dual-provider neural speech** — the OpenRouter key handles chat, vision, and
  fallback speech. An optional Google Gemini key provides primary Kannada TTS
  through the native Gemini API. Automatic mode tries Google, then OpenRouter,
  then the browser system voice.
- **Waveform-assisted lip-sync** — neural speech is decoded through Web Audio.
  Exact audio duration controls viseme pacing, while live waveform energy closes
  the mouth during pauses and scales jaw movement during voiced syllables.
- **No-echo live conversation** — 📞 starts a coordinated half-duplex call:
  listen → think → speak → acoustic pause → listen. The microphone is closed
  while Aria speaks, which prevents speaker output from feeding back as a new
  question. Use the red ■ control to interrupt a response safely.
- **Automatic image requests** — typed or spoken requests such as “generate an
  image of a tiger”, “show me a picture of Bengaluru”, `/image ...`, or
  “ಬೆಂಗಳೂರಿನ ಚಿತ್ರವನ್ನು ರಚಿಸಿ” route directly to Stability AI. Questions about
  camera images continue to use vision chat instead of generating new images.
- **Stability AI image generation** — enter a Stability key and choose Stable
  Image Core or Ultra plus an aspect ratio. Generated WebP images appear as
  dedicated cards with cancellation and download controls.
- **Vision (camera)** — tap 📷 to share your webcam. A live preview appears over
  the avatar. Each turn can include two chronological frames, allowing Aria to
  inspect static details (fingers, shirt colour, objects) and simple visible
  gestures. Requires a vision-capable model.
- **Expressive face** — eyebrow raises, eye **saccades** (natural darting
  gaze), blinking, cheek/nose/squint movement, head nods while talking, and an
  **emotion** read from the reply (happy / curious / excited) that shapes the
  brows and smile.
- **Glassmorphism chat UI** — animated message bubbles, bouncing typing
  indicator, live status pill (Online / Thinking / Speaking).
- **OpenRouter integration** — bring your own key and model.
- **Customisable personality** — edit Aria's system prompt in settings.
- **Served as static modules** — no package install or build step.

## 🚀 Getting started

1. Serve the project: `python3 -m http.server 8000`.
2. Open `http://localhost:8000` in Chrome or Edge.
3. Click **⚙ settings** and add the provider keys you use: OpenRouter for
   chat/vision, Google for primary Kannada speech, and Stability AI for image
   generation. Leave speech mode on Automatic.
4. Tap 📞 for a no-echo conversation or 🎤 for one voice turn. Ask “generate
   an image of…” by text or voice to route that request automatically to
   Stability AI; the picture button remains available as a manual shortcut.

Your keys are stored in the browser's `localStorage`. The OpenRouter key is
sent only to OpenRouter, the Google key only to Google's native Gemini API,
and the Stability key only to `api.stability.ai`. For public deployment, move
all provider credentials behind a server-side proxy.

## 📁 Project structure

```
.
├── index.html    # markup, import map, 3D canvas + chat UI
├── style.css     # theme, layout, animations
├── avatar3d.js   # Three.js engine: loads the face, blink/breathe/talk
├── app.js        # chat logic + OpenRouter client
└── README.md
```

> **Note:** the 3D avatar loads Three.js and the face model from a CDN, so an
> internet connection is required on first load. Run it from a local web server
> (modules + CDN won't work reliably from a `file://` page):
>
> ```bash
> python3 -m http.server 8000   # then open http://localhost:8000
> ```

## ⚠️ Security note

This is a **client-side only** app, so the API key lives in the browser. That's
fine for local/personal use. If you deploy it publicly, add a small backend
proxy that keeps the key server-side — never ship a real key in client code.

## 🛠️ Customise

- **Avatar model:** swap `MODEL_URL` in `avatar3d.js` for a compatible GLB with
  ARKit morph targets (`jawOpen`, `eyeBlink_L/R`, `mouthSmile_L/R`, etc.).
- **Expression / motion:** tune the blink cadence, talking jaw range, and
  idle head-sway in the `animate()` loop of `avatar3d.js`.
- **Behaviour:** tweak `DEFAULT_MODEL` and `DEFAULT_PERSONA` in `app.js`.

## 📄 License

MIT
