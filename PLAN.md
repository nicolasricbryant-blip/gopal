# GoPal 2.0 — Phone-Only Anti-Drowsiness PWA — Build Plan

Recreation of GoPal research prototype (see `docs/research-summary.md`). Original used
ESP32 DevKitC + Arduino UNO Q + webcam + VC-02 voice kit + DFPlayer Mini + Arduino Cloud.
**All hardware replaced by one phone.** Same functions, better portability/accessibility/compute.

## Hardware mapping (original → phone)

| Original component | Phone replacement |
|---|---|
| Web camera | Front camera via `getUserMedia` |
| ESP32 + Arduino UNO Q (processing) | Phone CPU/GPU — MediaPipe FaceLandmarker (WASM/WebGL, on-device) |
| VC-02 offline voice recognition | Web Speech API `SpeechRecognition` (on-device on modern Android) |
| DFPlayer Mini + speaker | `speechSynthesis` TTS + WebAudio beeps through phone speaker |
| Arduino Cloud IoT dashboard + mobile alerts | In-app dashboard + Telegram bot push (auto) + SMS deep-link (one-tap) |
| GPS module (implied via cloud alerts) | Geolocation API |
| 5V supply | Phone battery + Wake Lock API (screen stays on) |

## Platform decision (user-approved)

- **Web PWA** — vanilla HTML/CSS/JS ES modules, **no build step**, no framework.
- MediaPipe `@mediapipe/tasks-vision` via CDN (jsdelivr), face_landmarker model cached by service worker.
- Camera requires secure context: works on `localhost` (desktop dev) and any HTTPS host (phone use).
- **Conversation brain: hybrid** — cloud LLM when online + API key set; scripted dialogue bank fallback offline (parity with original VC-02 offline claim).
- **Alerts: both** — Telegram bot = automatic channel with GPS link; SMS = prefilled `sms:` compose, one tap (browser cannot auto-send SMS — documented limitation vs native).

## File layout

```
goPal/
  index.html          app shell, 4 screens (Monitor / Dashboard / Settings / Contacts)
  manifest.json       PWA manifest, standalone, dark theme_color
  sw.js               service worker: cache shell + MediaPipe wasm/model for offline
  css/main.css        design tokens + all styles
  js/app.js           screen router, boot, wake lock, orientation handling
  js/camera.js        front camera stream management
  js/detector.js      FaceLandmarker loop, EAR/MAR/PERCLOS computation
  js/fsm.js           drowsiness state machine + escalation logic
  js/assistant.js     conversation manager: STT, TTS, LLM adapters, scripted fallback
  js/alerts.js        WebAudio beep, Telegram push, SMS deep-link, GPS fetch
  js/dashboard.js     live stats, event log, session history, charts (canvas, no lib)
  js/storage.js       localStorage: settings, contacts, sessions, API keys
  js/metrics.js       response-time instrumentation (mirrors paper's tests)
  assets/icons/       app icons (192/512 PNG can be simple generated SVG→canvas), inline SVG UI icons
  docs/research-summary.md   1-page summary of original paper (functions + results to match)
```

## Detection spec (js/detector.js)

- MediaPipe **FaceLandmarker**, `runningMode: "VIDEO"`, 1 face, GPU delegate w/ CPU fallback.
- Loop via `requestAnimationFrame`, target ≥15 FPS processing; skip frames if slow device.
- **EAR** (Eye Aspect Ratio) from landmarks:
  - Left eye: 33, 160, 158, 133, 153, 144 — Right eye: 362, 385, 387, 263, 373, 380
  - `EAR = (|p2-p6| + |p3-p5|) / (2*|p1-p4|)`; average both eyes.
  - Also read `blendshapes` `eyeBlinkLeft/Right` as secondary signal (closed if > 0.5).
- **Eyes closed** when EAR < calibrated threshold (default 0.21).
- **Calibration**: on session start, 5 s eyes-open baseline → threshold = 75 % of baseline EAR. Skippable, persisted.
- **PERCLOS**: rolling 60 s window, % of frames with ≥80 % closure (use EAR < threshold as proxy). Drowsy classification when PERCLOS ≥ 15 %.
- **Yawn (MAR)**: mouth landmarks 13 (upper lip), 14 (lower lip), 78, 308 (corners). `MAR = |13-14| / |78-308|`; yawn when MAR > 0.6 sustained ≥ 1.5 s. Count per session.
- **No face detected > 3 s** → treat as attention loss → WARNING path.

## State machine (js/fsm.js) — exact parity with paper

```
ALERT (normal)
  └─ eyes closed ≥ 2.0 s  →  WARNING
       actions: WebAudio beep + assistant verbal check-in (TTS), t0 logged
  └─ WARNING and closure continues to 4 s total (2 s + grace so the check-in can start; or PERCLOS ≥ 15 %, or yawns ≥ 3/min)
       →  CRITICAL ("Critical Drowsy")
       actions: louder alarm pattern, Telegram auto-alert with GPS link,
                SMS compose button surfaces, assistant escalates to active dialogue,
                dashboard event logged
  └─ driver responds vocally / eyes reopen and stay open 10 s → de-escalate one level
```

All transitions timestamped into metrics log.

## Assistant (js/assistant.js)

- **STT**: `webkitSpeechRecognition || SpeechRecognition`, continuous=false, restart per turn, lang from settings (default `en-US`, offer `fil-PH`).
- **TTS**: `speechSynthesis`, rate 1.0, pick local voice; queue management (cancel on new critical event).
- **Turn loop**: assistant speaks → listens ≤ 8 s → replies. Log turn-taking latency (paper metric: 2.76 s target).
- **LLM adapters** (settings pick provider + key, stored localStorage only):
  - **Gemini**: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=KEY` (browser-callable, free tier — recommended default for the team).
  - **Claude**: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, model `claude-haiku-4-5-20251001`, max_tokens ~150.
  - System prompt: co-pilot keeping drowsy driver alert; SHORT replies (≤ 2 sentences), ask engaging questions, never tell driver to close eyes; if driver unresponsive, urge pulling over to rest.
- **Scripted fallback** (offline / no key / fetch error): bank of ~20 check-in dialogues — trivia, simple math, "tell me about your destination", stretch prompts; keyword-match driver reply to pick follow-up; always functional with zero connectivity (matches VC-02 parity).
- Timeout: LLM call > 4 s → abort → fallback line (keeps conversational latency near paper's numbers).

## Alerts (js/alerts.js)

- **Beep**: WebAudio oscillator, 880 Hz double-pulse (WARNING), continuous sweep pattern (CRITICAL). Respect volume setting.
- **GPS**: `navigator.geolocation.getCurrentPosition` (high accuracy); build `https://maps.google.com/?q=lat,lng`.
- **Telegram** (automatic): `GET https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=...` — message: driver name, "CRITICAL drowsiness detected", timestamp, maps link. Settings store bot token + chat id; "Test alert" button. Setup instructions shown in Settings (BotFather, get chat id via getUpdates).
- **SMS** (manual-confirm): `sms:<numbers>?body=<urlencoded alert + maps link>` anchor, auto-surfaced full-width red button during CRITICAL. Multiple emergency contacts from Contacts screen.
- Alert latency logged: detection → Telegram HTTP 200 (paper metric: 3.98 s target).

## Dashboard (js/dashboard.js) — replaces Arduino Cloud dashboard

- Live tiles: current state (ALERT/WARNING/CRITICAL), PERCLOS %, blink rate/min, yawn count, session duration, FPS.
- Event log (timestamped): state changes, alerts sent, assistant turns.
- Session summary on stop: totals + **mean latencies** (mobile alert, assistant activation, conversational turn-taking) — direct comparison table against paper's 3.98 s / 2.48 s / 2.76 s means.
- History: past sessions in localStorage; simple canvas bar chart alertness/events per session; CSV export button (research data collection).

## UI / design directives (ui-ux-pro-max, user-approved)

- **OLED dark only**. Tokens: `--bg: #020617`, `--surface: #0F172A`, `--surface-2: #1E293B`,
  `--border: #334155`, `--text: #F8FAFC`, `--text-muted: #94A3B8`, `--accent: #38BDF8`,
  `--ok: #34D399`, `--warn: #FBBF24`, `--critical: #F87171`.
- All state colors paired with icon + text label (never color alone). Contrast ≥ 4.5:1 (verify muted text on surface).
- **Fonts**: Syncopate (headings/brand, uppercase, sparingly) + Space Mono (data/labels, tabular figures for timers/metrics). Google Fonts with `font-display: swap`; system-ui fallback offline.
- **Monitor screen** = primary: full-bleed camera preview (mirrored), huge status ring around face area or top banner — glanceable from driver seat: state word + color + icon, EAR/PERCLOS small mono readouts, big mic/assistant activity indicator. One primary action per screen (Start/Stop session).
- Bottom nav, 4 items max, icon + label, ≥ 48 px touch targets, safe-area insets (`env(safe-area-inset-*)`), `viewport-fit=cover`, `min-h: 100dvh`, no horizontal scroll, works portrait + landscape (phone mounted either way).
- Micro-interactions 150–300 ms, transform/opacity only, `prefers-reduced-motion` respected. Critical state may pulse (reduced-motion → static high-contrast banner instead).
- Inline SVG icons single stroke style (Lucide-style paths, hand-inlined, no icon-font, no emoji-as-icon).
- Forms (Settings/Contacts): visible labels, helper text, semantic input types (`tel`, `password` for keys w/ show toggle), inline validation on blur, test buttons give success/error feedback.

## PWA / platform glue

- `manifest.json`: standalone, portrait-any, dark `theme_color #020617`, icons 192/512.
- `sw.js`: cache-first app shell + MediaPipe wasm + `.task` model (versioned cache); network-first for nothing critical; app fully usable offline except LLM/Telegram.
- **Wake Lock API** during session, re-acquire on visibilitychange.
- Permissions flow: camera, mic, location requested on session start with plain-language explainer screen first.
- Feature-detect everything; graceful message on unsupported browsers (target: Chrome/Android primary).

## Verification checklist (builder must do)

1. `python -m http.server` (or `npx serve`) in project dir; open `http://localhost:PORT` in browser pane.
2. Console clean on boot; all screens navigable; settings persist across reload.
3. Detector: FaceLandmarker loads, FPS + EAR readouts live with camera (desktop webcam OK for dev).
4. Simulate: close eyes 2 s → beep + TTS check-in; keep closed → CRITICAL banner + SMS button + Telegram attempt (logs error gracefully w/o token).
5. Scripted assistant works with **no API key** (offline parity).
6. Dashboard logs events + computes latency means; CSV export downloads.
7. Lighthouse-ish PWA sanity: manifest valid, SW registers, installable.

## Explicit limitations to document in README

- Browser cannot auto-send SMS → Telegram is the automatic channel; SMS is one-tap.
- Web Speech STT may need network on some devices (Chrome on-device models vary).
- iOS Safari: no Web Speech STT / limited — target Android Chrome; note as future work.
- HTTPS needed on phone → deploy to any static host (GitHub Pages/Netlify) — do NOT deploy in this session.
```
