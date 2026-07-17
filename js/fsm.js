// fsm.js — drowsiness state machine + escalation logic. Exact parity with the paper:
//
// ALERT (normal)
//   -> eyes closed >= 2.0s                                   => WARNING
//   -> WARNING + closure continues past threshold,
//      or PERCLOS >= 15%, or yawns >= 3/min                  => CRITICAL
//   -> driver responds vocally, OR eyes reopen & stay open
//      10s straight                                          => de-escalate one level
//
// The FSM is a pure event emitter driven by detector.js signals; it has no DOM
// or camera knowledge. app.js wires it to alerts.js / assistant.js / dashboard.js.

export const STATE = {
  ALERT: 'ALERT',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

const EYES_CLOSED_WARNING_SEC = 2.0;
// Critical needs its own, longer closure threshold: reusing the 2s warning
// condition would escalate WARNING -> CRITICAL on the very next frame of a
// continuing closure, before the assistant check-in can even start speaking.
const EYES_CLOSED_CRITICAL_SEC = 4.0;
const EYES_OPEN_RECOVERY_SEC = 10.0;
const PERCLOS_CRITICAL_PCT = 15;
// PERCLOS is a fraction of a rolling window; early in a session the window is
// tiny, so a couple seconds of closure can spike the percentage past the
// critical threshold. Require the window to have accumulated enough span
// before letting PERCLOS alone drive an escalation.
const PERCLOS_MIN_WINDOW_MS = 30_000;
const YAWN_RATE_CRITICAL_PER_MIN = 3;
const NO_FACE_WARNING_SEC = 3.0;
// Same one-frame-escalation class of bug as EYES_CLOSED_CRITICAL_SEC above:
// no-face needs its own, longer threshold so WARNING doesn't escalate to
// CRITICAL on the very next frame after crossing the 3s warning mark.
const NO_FACE_CRITICAL_SEC = 6.0;
// If the update loop was suspended (tab hidden, rAF paused) for longer than
// this, treat it as a gap rather than continuous closure/no-face duration —
// otherwise resuming after a long hide falsely reports the eyes/face as
// having been closed/lost the entire time the tab was backgrounded.
const UPDATE_GAP_RESET_MS = 2000;

export class DrowsinessFSM extends EventTarget {
  constructor() {
    super();
    this.state = STATE.ALERT;
    this.enteredStateAt = performance.now();
    this.eyesClosedSince = null;
    this.eyesOpenSince = performance.now();
    this.noFaceSince = null;
    this.lastVocalResponseAt = null;
    this.lastUpdateAt = performance.now();
  }

  _setState(next, reason) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.enteredStateAt = performance.now();
    this.dispatchEvent(new CustomEvent('transition', {
      detail: { from: prev, to: next, reason, at: Date.now() },
    }));
  }

  /**
   * Feed the latest detector frame into the machine.
   * @param {object} sample
   *   sample.eyesClosed: boolean
   *   sample.faceDetected: boolean
   *   sample.perclos: number (0-100, rolling window)
   *   sample.perclosWindowSpanMs: number — actual span covered by the PERCLOS
   *     window so far; PERCLOS is ignored as a critical signal until this
   *     reaches PERCLOS_MIN_WINDOW_MS (else the ratio is noisy early on).
   *   sample.yawnsPerMin: number
   *   sample.nowMs: number (performance.now() at sample time)
   */
  update(sample) {
    const now = sample.nowMs ?? performance.now();
    const { eyesClosed, faceDetected, perclos, yawnsPerMin } = sample;

    // If the loop was suspended (tab hidden, rAF paused) for a while, don't
    // let the gap masquerade as continuous eyes-closed/no-face duration on
    // resume — reset the trackers to "now" so this frame reads as 0 duration.
    if (now - this.lastUpdateAt > UPDATE_GAP_RESET_MS) {
      this.eyesClosedSince = now;
      this.eyesOpenSince = now;
      this.noFaceSince = now;
    }
    this.lastUpdateAt = now;

    // Track no-face duration -> treated as attention loss.
    if (!faceDetected) {
      if (this.noFaceSince === null) this.noFaceSince = now;
    } else {
      this.noFaceSince = null;
    }
    const noFaceDurationSec = this.noFaceSince !== null ? (now - this.noFaceSince) / 1000 : 0;

    // Track closed/open eye durations.
    if (eyesClosed) {
      if (this.eyesClosedSince === null) this.eyesClosedSince = now;
      this.eyesOpenSince = null;
    } else {
      if (this.eyesOpenSince === null) this.eyesOpenSince = now;
      this.eyesClosedSince = null;
    }
    const closedDurationSec = this.eyesClosedSince !== null ? (now - this.eyesClosedSince) / 1000 : 0;
    const openDurationSec = this.eyesOpenSince !== null ? (now - this.eyesOpenSince) / 1000 : 0;

    const attentionLost = noFaceDurationSec >= NO_FACE_WARNING_SEC;
    const noFaceCritical = noFaceDurationSec >= NO_FACE_CRITICAL_SEC;
    const closedPastWarning = closedDurationSec >= EYES_CLOSED_WARNING_SEC;
    const closedPastCritical = closedDurationSec >= EYES_CLOSED_CRITICAL_SEC;
    const perclosWindowSpanMs = sample.perclosWindowSpanMs ?? Infinity;
    const perclosCritical = perclos >= PERCLOS_CRITICAL_PCT && perclosWindowSpanMs >= PERCLOS_MIN_WINDOW_MS;
    const criticalSignal = closedPastCritical || perclosCritical || yawnsPerMin >= YAWN_RATE_CRITICAL_PER_MIN;
    const recovered = openDurationSec >= EYES_OPEN_RECOVERY_SEC && !attentionLost;

    switch (this.state) {
      case STATE.ALERT:
        if (closedPastWarning || attentionLost) {
          this._setState(STATE.WARNING, attentionLost ? 'no-face' : 'eyes-closed-2s');
        }
        break;

      case STATE.WARNING:
        if (criticalSignal || noFaceCritical) {
          this._setState(STATE.CRITICAL, noFaceCritical ? 'no-face-sustained' : 'closure-sustained-or-perclos-or-yawn');
        } else if (recovered) {
          this._setState(STATE.ALERT, 'recovered');
        }
        break;

      case STATE.CRITICAL:
        if (recovered) {
          this._setState(STATE.WARNING, 'partial-recovery');
        }
        break;
    }

    return {
      state: this.state,
      closedDurationSec,
      openDurationSec,
      noFaceDurationSec,
      perclos,
      yawnsPerMin,
    };
  }

  /** Call when the driver responds vocally to the assistant — de-escalates one level. */
  registerVocalResponse() {
    this.lastVocalResponseAt = performance.now();
    if (this.state === STATE.CRITICAL) {
      this._setState(STATE.WARNING, 'vocal-response');
    } else if (this.state === STATE.WARNING) {
      this._setState(STATE.ALERT, 'vocal-response');
    }
  }

  reset() {
    this.state = STATE.ALERT;
    this.enteredStateAt = performance.now();
    this.eyesClosedSince = null;
    this.eyesOpenSince = performance.now();
    this.noFaceSince = null;
    this.lastVocalResponseAt = null;
    this.lastUpdateAt = performance.now();
  }
}
