// fsm.test.js — DrowsinessFSM escalation/de-escalation thresholds.
// All samples pass an explicit nowMs so timing is fully controlled (no real clock).
// Steps stay <=2s apart on purpose — a bigger gap is treated as the update loop
// having been suspended (see the dedicated "update-loop suspension gap" tests
// below), so realistic ~200ms-cadence steps are used to reach each threshold.

import { describe, it, expect } from 'vitest';
import { DrowsinessFSM, STATE } from '../js/fsm.js';

function sample({ nowMs, eyesClosed = false, faceDetected = true, perclos = 0, yawnsPerMin = 0, perclosWindowSpanMs = 0 }) {
  return { nowMs, eyesClosed, faceDetected, perclos, yawnsPerMin, perclosWindowSpanMs };
}

// Feeds fsm.update() at stepMs cadence from fromMs to toMs (both inclusive), so
// no gap between calls exceeds stepMs. `overrides` is merged into every sample.
function feed(fsm, fromMs, toMs, stepMs, overrides) {
  let last;
  for (let t = fromMs; t < toMs; t += stepMs) {
    last = fsm.update(sample({ nowMs: t, ...overrides }));
  }
  return fsm.update(sample({ nowMs: toMs, ...overrides }));
}

describe('eyes-closed escalation', () => {
  it('escalates ALERT -> WARNING at 2.0s closed, not before', () => {
    const fsm = new DrowsinessFSM();
    fsm.update(sample({ nowMs: 0, eyesClosed: true }));
    expect(fsm.state).toBe(STATE.ALERT);
    feed(fsm, 0, 1900, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.ALERT);
    feed(fsm, 1900, 2000, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.WARNING);
  });

  it('escalates WARNING -> CRITICAL at 4.0s closed, not before', () => {
    const fsm = new DrowsinessFSM();
    feed(fsm, 0, 2000, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.WARNING);
    feed(fsm, 2000, 3999, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.WARNING);
    feed(fsm, 3999, 4000, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.CRITICAL);
  });
});

describe('PERCLOS escalation gated by window span', () => {
  function toWarning(fsm) {
    feed(fsm, 0, 2000, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.WARNING);
  }

  it('perclos >= 15% with a short (10s) window does NOT escalate to CRITICAL', () => {
    const fsm = new DrowsinessFSM();
    toWarning(fsm);
    fsm.update(sample({ nowMs: 2100, eyesClosed: false, perclos: 20, perclosWindowSpanMs: 10_000 }));
    expect(fsm.state).toBe(STATE.WARNING);
  });

  it('perclos >= 15% with a full (60s) window DOES escalate to CRITICAL', () => {
    const fsm = new DrowsinessFSM();
    toWarning(fsm);
    fsm.update(sample({ nowMs: 2100, eyesClosed: false, perclos: 20, perclosWindowSpanMs: 60_000 }));
    expect(fsm.state).toBe(STATE.CRITICAL);
  });
});

describe('no-face escalation', () => {
  it('ALERT -> WARNING at 3s no-face; needs 6s total for CRITICAL, not 1 frame after WARNING', () => {
    const fsm = new DrowsinessFSM();
    fsm.update(sample({ nowMs: 0, faceDetected: false }));
    expect(fsm.state).toBe(STATE.ALERT);
    feed(fsm, 0, 3000, 200, { faceDetected: false });
    expect(fsm.state).toBe(STATE.WARNING);
    // One frame later — must NOT instantly escalate to CRITICAL.
    fsm.update(sample({ nowMs: 3100, faceDetected: false }));
    expect(fsm.state).toBe(STATE.WARNING);
    feed(fsm, 3100, 6000, 200, { faceDetected: false });
    expect(fsm.state).toBe(STATE.CRITICAL);
  });
});

describe('recovery', () => {
  it('10s of eyes-open recovers WARNING -> ALERT', () => {
    const fsm = new DrowsinessFSM();
    feed(fsm, 0, 2000, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.WARNING);
    fsm.update(sample({ nowMs: 2100, eyesClosed: false }));
    feed(fsm, 2100, 12099, 500, { eyesClosed: false });
    expect(fsm.state).toBe(STATE.WARNING);
    fsm.update(sample({ nowMs: 12100, eyesClosed: false }));
    expect(fsm.state).toBe(STATE.ALERT);
  });
});

describe('registerVocalResponse', () => {
  it('de-escalates exactly one level', () => {
    const fsm = new DrowsinessFSM();
    feed(fsm, 0, 2000, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.WARNING);
    fsm.registerVocalResponse();
    expect(fsm.state).toBe(STATE.ALERT);

    // Eyes stay closed through the de-escalation and back past both thresholds.
    feed(fsm, 2000, 6100, 200, { eyesClosed: true });
    expect(fsm.state).toBe(STATE.CRITICAL);
    fsm.registerVocalResponse();
    expect(fsm.state).toBe(STATE.WARNING);
  });
});

describe('update-loop suspension gap', () => {
  it('a >2s gap between updates resets closure tracking instead of counting the gap as closed time', () => {
    const fsm = new DrowsinessFSM();
    fsm.update(sample({ nowMs: 0, eyesClosed: true }));
    expect(fsm.state).toBe(STATE.ALERT);
    // Tab was hidden for 30s; rAF resumes with eyes still closed.
    fsm.update(sample({ nowMs: 30_000, eyesClosed: true }));
    expect(fsm.state).not.toBe(STATE.CRITICAL);
    expect(fsm.state).toBe(STATE.ALERT);
  });
});
