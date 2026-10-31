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
- **Real lip-sync + voice** — Aria **speaks replies aloud** (Web Speech API)
  and her lips follow the words: text is converted to viseme mouth shapes and
  timed to the actual speech, resyncing on word boundaries. Toggle voice with
  the 🔊 button.
- **Voice commands** — tap the 🎤 mic button and **talk to Aria**; your speech
  is transcribed (Web Speech Recognition) and sent automatically. (Supported in
  Chrome/Edge/Safari; the button hides itself where unsupported.)
- **Vision (camera)** — tap 📷 to share your webcam. A live preview appears over
  the avatar, and each message you send includes the current frame, so Aria can
  **answer about what she sees** — count fingers, name your shirt colour,
  identify objects, etc. Requires a vision-capable model (the default
  `openai/gpt-4o-mini` works).
- **Expressive face** — eyebrow raises, eye **saccades** (natural darting
  gaze), blinking, cheek/nose/squint movement, head nods while talking, and an
  **emotion** read from the reply (happy / curious / excited) that shapes the
  brows and smile.
- **Glassmorphism chat UI** — animated message bubbles, bouncing typing
  indicator, live status pill (Online / Thinking / Speaking).
- **OpenRouter integration** — bring your own key and model.
- **Customisable personality** — edit Aria's system prompt in settings.
- **Zero dependencies** — just open `index.html`.

## 🚀 Getting started

1. Open `index.html` in any modern browser.
2. Click the **⚙ settings** icon.
3. Paste your **OpenRouter API key** (`sk-or-v1-…`), pick a model
   (default `openai/gpt-4o-mini`), optionally tweak the personality.
4. Start chatting with Aria.

Your key is stored **only** in your browser's `localStorage` and is sent
only to OpenRouter.

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

- **Avatar model:** swap `MODEL_URL` in `avatar3d.js` for any GLB with ARKit
  blendshapes (`jawOpen`, `eyeBlinkLeft/Right`, `mouthSmile…`).
- **Expression / motion:** tune the blink cadence, talking jaw range, and
  idle head-sway in the `animate()` loop of `avatar3d.js`.
- **Behaviour:** tweak `DEFAULT_MODEL` and `DEFAULT_PERSONA` in `app.js`.

## 📄 License

MIT
