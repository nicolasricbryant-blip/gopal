# GoPal original research — summary (AY 2025-2026, Aklan Valley HS)

Paper: "GoPal: An AI-Powered Anti-Drowsiness System with Visual Detection and
Conversational Assistance for Drivers" — Nicolas, Tefora, Rentino.

## What original system did

- Webcam watches driver face. Detects eye closure (EAR → PERCLOS) + yawning.
- Eyes closed 2 s → warning threshold: beep + AI assistant verbal check-in.
- Closure past 2 s → "Critical Drowsy": mobile alert + real-time GPS coords sent
  to family/authorities via ESP32 → Arduino Cloud IoT dashboard.
- Assistant = VC-02 offline voice recognition + DFPlayer Mini canned audio prompts.
  Driver talks back → assistant keeps dialogue going → cognitive re-engagement.

## Hardware (all replaced by phone in 2.0)

ESP32 DevKitC, Arduino UNO Q, web camera, VC-02 voice kit, DFPlayer Mini + speaker,
jumper wires, 5V supply, Arduino Cloud.

## Results to benchmark against

- Functionality: 100% (5/5 trials, all components).
- Response time means: mobile alert 3.98 s, assistant activation 2.48 s,
  conversational turn-taking 2.76 s.
- Effectiveness (10 participants, stationary sim): fatigue signs 61 → 11
  (81.97% reduction); mean alertness score 2.3 (Drowsy) → 4.2 (Very Good).
- Hypotheses: alert < 5 s, activation < 3 s, turn-taking < 3 s — all met.

## Paper's own recommendations (2.0 addresses)

- Reduce data-connection dependence → offline scripted assistant fallback.
- Better packaging/integration → everything in one phone.
- Varied lighting untested → note as limitation; phone cameras handle low light better.
