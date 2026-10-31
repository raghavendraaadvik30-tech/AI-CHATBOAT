# Aria · AI Avatar Chat 🤖💬

An attractive, animated **AI avatar chatbot** built with plain HTML, CSS, and
JavaScript — no frameworks, no build step. Aria is a hand-drawn SVG character
who **blinks**, **breathes**, and **talks** while she answers, powered by the
[OpenRouter](https://openrouter.ai) chat API.

![stack: html css js](https://img.shields.io/badge/stack-HTML%20%7C%20CSS%20%7C%20JS-8b5cf6)

## ✨ Features

- **Animated SVG avatar** — random blinking, idle breathing/float, a pulsing
  glow, and a talking mouth + eye glances synced to the streaming reply.
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
├── index.html   # markup + the SVG avatar
├── style.css    # theme, layout, and all animations
├── app.js       # chat logic, avatar FX, OpenRouter client
└── README.md
```

## ⚠️ Security note

This is a **client-side only** app, so the API key lives in the browser. That's
fine for local/personal use. If you deploy it publicly, add a small backend
proxy that keeps the key server-side — never ship a real key in client code.

## 🛠️ Customise

- **Look:** edit the gradients and `<path>` data in the `<svg id="avatar">` in
  `index.html` (hair, skin, outfit colours live in the `<defs>`).
- **Animations:** all keyframes (`blink`, `breathe`, `talk`, `float`,
  `pulse-glow`) are in `style.css`.
- **Behaviour:** tweak `DEFAULT_MODEL` and `DEFAULT_PERSONA` in `app.js`.

## 📄 License

MIT
