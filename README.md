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
- **Sarvam AI Indian-language speech** — Sarvam's Bulbul TTS is the primary
  voice for Kannada, Hindi, Tamil, Telugu, Malayalam (and more Indian
  languages), routed through the Node proxy so the key stays server-side.
  OpenRouter (`fish-audio/drama-3`) is the fallback, and English can use a free
  local browser voice. Set the provider in Settings → Speech quality.
- **Waveform-assisted lip-sync** — OpenRouter speech is decoded through Web
  Audio. Exact audio duration controls viseme pacing, while live waveform
  energy closes the mouth during pauses. Kannada and English have detailed
  mouth maps; other scripts use a waveform-driven universal jaw/lip fallback.
- **No-echo live conversation** — 📞 starts a coordinated half-duplex call:
  listen → think → speak → acoustic pause → listen. The microphone is closed
  while Aria speaks, which prevents speaker output from feeding back as a new
  question. Use the red ■ control to interrupt a response safely.
- **Automatic image requests** — typed or spoken requests such as “generate an
  image of a tiger”, “show me a picture of Bengaluru”, `/image ...`, or
  “ಬೆಂಗಳೂರಿನ ಚಿತ್ರವನ್ನು ರಚಿಸಿ” route directly to Cloudflare Workers AI. Questions about
  camera images continue to use vision chat instead of generating new images.
- **Cloudflare Workers AI image generation** — FLUX.1 schnell by default, with
  configurable aspect ratios. The Node server proxy keeps the token server-side.
  Every request has a deadline, live elapsed time, immediate cancellation, and
  a downloadable result.
- **Vision (camera)** — tap 📷 to share your webcam. A live preview appears over
  the avatar. Each turn can include two chronological frames, allowing Aria to
  inspect static details (fingers, shirt colour, objects) and simple visible
  gestures. Requires a vision-capable model.
- **Emotional face** — the reply's meaning drives real expressions: joy,
  warmth/affection, surprise, sadness/empathy, concern, and playful smirks,
  each with natural left/right asymmetry, smooth attack/release, staged
  asymmetric blinks, gaze-linked blinking, and eyes that lead slower head
  turns. Lightweight WebGL, so it runs without a dedicated GPU. The asset is a
  head-only ARKit rig; true photoreal video or full-body gestures would require
  a cloud talking-head service or a different licensed model.
- **Glassmorphism chat UI** — animated message bubbles, bouncing typing
  indicator, live status pill (Online / Thinking / Speaking).
- **OpenRouter integration** — bring your own key and model.
- **Customisable personality** — edit Aria's system prompt in settings.
- **Served as static modules** — no package install or build step.

## 🚀 Getting started

1. Use Node 18 or newer. Export your keys and start the included same-origin
   proxy:
   ```bash
   export CLOUDFLARE_ACCOUNT_ID="your-account-id"
   export CLOUDFLARE_API_TOKEN="your-workers-ai-token"   # needs Workers AI permission
   export SARVAM_API_KEY="your-sarvam-key"               # Indian-language speech
   # optional: CLOUDFLARE_IMAGE_MODEL (default @cf/black-forest-labs/flux-1-schnell)
   npm start
   ```
2. Open `http://localhost:8000` in Chrome or Edge.
3. Click **⚙ settings**. OpenRouter handles chat, camera vision, and speech;
   Cloudflare Workers AI handles image generation. No other provider key is used.
4. Choose English, Kannada, Hindi, Tamil, Telugu, or Malayalam. Tap 📞 for a
   no-echo conversation or 🎤 for one voice turn. Ask “generate an image of…”
   by text or voice to route that request automatically to Cloudflare Workers AI.

Your keys are stored in the browser's `localStorage` only when entered in
Settings. Server environment keys stay server-side. OpenRouter and Cloudflare
credentials are sent only to their matching provider. Retired provider
credentials and old speech-model settings are purged on load.

## 📁 Project structure

```
.
├── index.html    # markup, import map, 3D canvas + chat UI
├── style.css     # theme, layout, animations
├── avatar3d.js   # Three.js engine: loads the face, blink/breathe/talk
├── server.mjs    # static server + secure Cloudflare image proxy
├── package.json  # dependency-free npm start command
├── app.js        # chat, live-call, provider and image-generation coordinator
└── README.md
```

> **Note:** the 3D avatar loads Three.js and the face model from a CDN, so an
> internet connection is required. `npm start` is recommended because it also
> enables the same-origin image proxy. `python3 -m http.server 8000` still runs
> the client, but image generation will not work because it needs the proxy.

## ⚠️ Security note

The Node proxy keeps `CLOUDFLARE_API_TOKEN` server-side. The OpenRouter key is
stored in browser `localStorage` for this local/personal demo. Before a public
release, proxy OpenRouter too, then add authentication and rate limiting.

## 🛠️ Customise

- **Avatar model:** swap `MODEL_URL` in `avatar3d.js` for a compatible GLB with
  ARKit morph targets (`jawOpen`, `eyeBlink_L/R`, `mouthSmile_L/R`, etc.).
- **Expression / motion:** tune the blink cadence, talking jaw range, and
  idle head-sway in the `animate()` loop of `avatar3d.js`.
- **Behaviour:** tweak `DEFAULT_MODEL` and `DEFAULT_PERSONA` in `app.js`.

## 📄 License

MIT
