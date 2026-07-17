# GoPal 2.0 — Phone-Only Anti-Drowsiness PWA

GoPal watches your face through your phone's front camera while you drive, and
speaks up before drowsiness becomes dangerous. It's a from-scratch recreation
of a hardware-based driver drowsiness system (ESP32 + webcam + offline voice
kit + IoT dashboard) — GoPal 2.0 replaces all of that hardware with one phone.
See `docs/research-summary.md` for the original research this is based on.

## What it does

- **Watches your eyes and mouth** using on-device face landmark detection
  (MediaPipe FaceLandmarker, runs entirely in the browser — no video ever
  leaves your phone). Computes eye-closure (EAR), PERCLOS, blink rate, and
  yawning (MAR).
- **Escalates in three stages**: `ALERT` (normal) → `WARNING` (eyes closed
  ≥2s: beep + a verbal check-in from the assistant) → `CRITICAL` (closure
  persists, or PERCLOS ≥15%, or yawning ≥3/min: louder alarm, automatic
  Telegram alert with your GPS location, and a one-tap SMS button).
- **Talks to you** to keep you cognitively engaged — either through a cloud
  LLM (Gemini or Claude, your choice) for natural conversation, or a built-in
  scripted dialogue bank that works with **zero internet connection**.
- **Dashboard** shows live stats, an event log, and a session summary
  comparing your response-time metrics against the original paper's
  benchmarks (mobile alert 3.98s, assistant activation 2.48s, conversational
  turn-taking 2.76s). Session history persists locally with CSV export.
- **Installable PWA**: works offline (except the LLM/Telegram network calls,
  which obviously need a connection), add-to-home-screen, dark OLED theme.

## Running it locally

No build step, no npm install — it's vanilla HTML/CSS/JS (ES modules).

```bash
cd goPal
python -m http.server 8123
```

Then open `http://localhost:8123` in Chrome (desktop Chrome with a webcam
works fine for development — camera access is allowed on `localhost` without
HTTPS). Grant camera/mic/location permissions when prompted.

If you don't have Python, any static file server works, e.g. `npx serve .`.

## Deploying to your phone

Camera access requires a **secure context** — either `localhost` or HTTPS.
Your phone can't reach your dev machine's `localhost`, so to use GoPal on an
actual phone you need to host it somewhere with HTTPS: GitHub Pages, Netlify,
Vercel, Cloudflare Pages, etc. all work and are free for a static site like
this. **This build was not deployed anywhere as part of this task** — pick a
host and push these files when you're ready.

Once hosted, open the HTTPS URL on your phone in Chrome (Android is the
primary target — see Limitations below for iOS Safari caveats), then use
"Add to Home Screen" to install it as a standalone app.

## Telegram bot setup (automatic alerts)

Telegram is the **automatic** alert channel — browsers can't send SMS without
a user tapping "send" first, so Telegram is what actually fires on its own
when a CRITICAL event happens.

1. Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts.
   BotFather gives you a **bot token** — copy it.
2. Send any message to your new bot (search for it by the username you gave
   it) so it has a conversation to reply into.
3. In a browser, visit:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   Find `"chat":{"id":<NUMBER>,...}` in the response — that number is your
   **chat ID**.
4. In GoPal → Settings → Telegram Alerts, paste the token and chat ID, then
   tap **Send Test Alert** to confirm it works.

Both values are stored only in your browser's `localStorage` — never sent
anywhere except directly to the Telegram API from your own device.

## API key setup (Gemini or Claude) — optional

The assistant works with **no key at all** using the built-in scripted
dialogue bank (offline-safe, matches the original system's offline voice
kit). If you want richer, LLM-generated conversation:

- **Gemini** (recommended — has a free tier and is directly browser-callable):
  get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- **Claude**: get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).

Paste the key into Settings → Conversation Brain. Keys are stored only in
`localStorage` on your device and sent only to the respective provider's API
directly from your browser.

## Known limitations

- **Browser cannot auto-send SMS.** There's no web API to silently send a
  text message — the browser can only open the phone's SMS app with a
  prefilled message via an `sms:` link, which still requires the user to tap
  send. Telegram is therefore the automatic channel; the SMS button during a
  CRITICAL alert is one-tap, not zero-tap.
- **Web Speech STT may require network** on some Android devices/Chrome
  versions, depending on whether an on-device speech model is installed —
  this varies by device and isn't fully within the app's control.
- **iOS Safari has no `SpeechRecognition` support** (or only very limited,
  non-standard support). Voice check-in listening will silently no-op on
  iOS — the assistant will still *speak* (TTS works fine) but won't hear
  replies. **Android Chrome is the primary target platform**; full iOS
  support is future work.
- **HTTPS is required on a phone.** Camera/mic/geolocation are all gated
  behind secure-context requirements in every mobile browser. See "Deploying
  to your phone" above — nothing was deployed as part of this build.
- **Varied lighting was untested** in the original research; phone front
  cameras generally handle low light better than the original setup's
  webcam, but detection accuracy in very dark cabins is still unverified.
- **PERCLOS is an EAR-threshold proxy**, not the strict "≥80% eyelid closure"
  photometric definition from the sleep-research literature — this matches
  the spec's detection design but is worth knowing if comparing to other
  PERCLOS implementations.
- **Data-connection dependence is reduced but not eliminated.** The face
  detector, FSM, alarms, and scripted assistant all work fully offline once
  the app shell + MediaPipe model are cached by the service worker. Telegram
  alerts and LLM conversation both require connectivity by nature.

## File layout

```
goPal/
  index.html          app shell, 4 screens (Monitor / Dashboard / Settings / Contacts)
  manifest.json        PWA manifest
  sw.js                 service worker (offline caching)
  css/main.css          design tokens + all styles
  js/app.js              screen router, boot, wake lock, session orchestration
  js/camera.js            front camera stream management
  js/detector.js          MediaPipe FaceLandmarker loop, EAR/MAR/PERCLOS
  js/fsm.js                drowsiness state machine
  js/assistant.js          STT/TTS, LLM adapters, scripted fallback
  js/alerts.js              beeps, Telegram, SMS deep-link, GPS
  js/dashboard.js            live stats, event log, history, CSV export
  js/storage.js               localStorage persistence
  js/metrics.js                 response-time instrumentation
  assets/icons/                 PWA icons (generate_icons.py regenerates them)
  docs/research-summary.md      summary of the original research this recreates
```
