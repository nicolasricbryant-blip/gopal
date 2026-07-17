# HANDOFF — GoPal 2.0

## State: v4 bugfix round done + test suite added, deployed both hosts. Not yet phone-tested by user.

## What
Phone-only recreation of orig ESP32/Arduino drowsiness research (see
`docs/research-summary.md`). Vanilla JS PWA, no build step. Full spec in
`PLAN.md`.

## Live URLs
- Netlify (primary, root scope): https://gopal-antidrowsiness.netlify.app
- GitHub Pages (subpath scope): https://nicolasricbryant-blip.github.io/gopal/
- Repo: https://github.com/nicolasricbryant-blip/gopal (public)
- Netlify project: `gopal-antidrowsiness`, id `a4d93b50-be14-47e6-912c-d4594a1c0c45`,
  linked via `.netlify/` (gitignored) in this dir.

## Built by
Sonnet subagent built all files from PLAN.md. Fable (Opus role) reviewed +
fixed 4 bugs before/during deploy — see commit `5f75338` + inline code.

## Known-fixed bugs (don't reintroduce)
1. `js/fsm.js` — WARNING→CRITICAL used same 2s closure cond as ALERT→WARNING,
   fired CRITICAL 1 frame after WARNING. Now CRITICAL needs 4s total closure
   (`EYES_CLOSED_CRITICAL_SEC`). Verified live: WARNING@2.0s, CRITICAL@4.0s.
2. `css/main.css` — `@import` for Google Fonts must be the first rule or
   browsers silently drop it. Was after a `@font-face`, moved to top.
3. `js/assistant.js` + `js/app.js` — latency metrics now use TTS `onstart`
   hooks so activation/turn-taking timing matches paper's definitions exactly.
4. `manifest.json` id `/` → `./` and `sw.js` shell-match regex — both broke
   under GitHub Pages' `/gopal/` subpath (root-relative assumptions). Netlify
   serves from root so wasn't affected, but fix is shared code — already live
   on both.

## v4 bugfix round (Fable review + Sonnet subagent build, 2026-07-17)
Same one-frame-escalation bug class as #1 hit two more paths — regression
tests now cover the whole class. 11 fixes, all under vitest:
1. `js/fsm.js` — no-face WARNING→CRITICAL reused 3s cond; now needs 6s
   (`NO_FACE_CRITICAL_SEC`).
2. `js/fsm.js` + `js/detector.js` — PERCLOS window tiny early-session →
   instant CRITICAL. Sample now carries `perclosWindowSpanMs`; PERCLOS
   ignored as critical signal until span ≥30s (`PERCLOS_MIN_WINDOW_MS`).
3. `js/assistant.js` — LLM history sent driver reply twice + turn-2 history
   started with assistant role (Claude API 400). `buildProviderHistory()`
   drops leading assistant msgs, merges same-role runs. LLM mode works past
   turn 1 now.
4. `sw.js` — non-OK responses were cached forever (one CDN 500 = permanent
   broken model). Now gated on `res.ok`. Cache bumped to `gopal-v4`.
5. `sw.js` — shell matching scoped to same-origin pathnames.
6. `js/detector.js` + `js/app.js` — calibration Skip truly cancels
   (`cancelCalibration()`, threshold untouched); main loop paused during
   mid-session recalibrate (no concurrent `detectForVideo`).
7. `js/app.js` + `js/metrics.js` — alert latency only on `result.ok`, else
   `metrics.cancel('alert')`.
8. `js/assistant.js` + `js/app.js` — TTS respects volume slider
   (`utter.volume`).
9. `js/fsm.js` — >2s update gap (hidden tab) resets closure tracking, no
   false CRITICAL on tab return (`UPDATE_GAP_RESET_MS`).
10. `js/app.js` — crash guard: `earThreshold` type-checked before `.toFixed`.
11. `js/facemath.js` (new) — pure EAR/MAR math extracted for testing; in
    sw.js SHELL_FILES.

## Tests
`npm test` (vitest, node env, no build step impact — devDep only).
4 files, 23 tests: FSM timing incl. both instant-escalation regressions,
facemath, `buildProviderHistory`, storage (localStorage stubbed pre-import).
FSM tests feed samples at ≤500ms cadence — bigger jumps trip the gap-reset
(fix 9) and false-fail; one dedicated test covers the real gap behavior.

## Verified (this session)
- Both deploys: SW activates, correct scope, zero console errors, boots to
  Monitor screen, all assets 200.
- Scripted assistant runs a full turn with zero API key (offline parity).
- FSM synthetic test: WARNING/CRITICAL timing exact, vocal response
  de-escalates one level.
- Settings persist to localStorage across reload.
- NOT verified: real camera/mic detection loop (browser tool blocks device
  capture) — needs a real phone or desktop-with-webcam test.

## Next steps (user-owned)
1. Open either URL on Android Chrome, grant camera/mic/location, run a real
   session — close eyes ~2s (expect beep+voice) and ~4s (expect critical
   alarm + SMS button). Also worth testing after v4: calibration Skip,
   mid-session recalibrate, cover camera 3s/6s (WARNING then CRITICAL),
   background the tab and return (no false CRITICAL).
2. If assistant conversation wanted: add Gemini or Claude key in Settings
   (works fine without one — scripted fallback).
3. If Telegram auto-alerts wanted: follow README Telegram section.
4. iOS not fully supported (no Web Speech STT) — Android Chrome is primary
   target, documented in README limitations.

## Gotcha for future deploys
Netlify CLI on this machine had a stray project link pointing at an
unrelated site (`dictattendance`) before this session — `netlify link` in a
fresh dir can silently inherit the wrong link. Always run `netlify status`
before deploying from a new project dir; unlink/relink explicitly if it
shows the wrong project.

## To redeploy after code changes
1. Bump `CACHE_VERSION` in `sw.js` (service worker caches aggressively —
   phones won't see new code otherwise).
2. `git add -A && git commit && git push` → Pages auto-rebuilds.
3. Netlify (manual, not auto-linked to git push). Since vitest was added,
   `--dir .` would upload node_modules — deploy a clean copy of HEAD:
   `git archive HEAD | tar -x -C <tmpdir>` then
   `netlify deploy --prod --dir <tmpdir> --site a4d93b50-be14-47e6-912c-d4594a1c0c45`
4. Run `npm test` before deploying — 23 tests must stay green.
