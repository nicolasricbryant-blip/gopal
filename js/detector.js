// detector.js — MediaPipe FaceLandmarker loop: EAR / MAR / PERCLOS / blink / yawn computation.
// Loaded from jsdelivr CDN as an ES module; model file cached by the service worker for offline use.

import {
  FilesetResolver,
  FaceLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { LEFT_EYE, RIGHT_EYE, computeEAR, computeMAR } from './facemath.js';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const DEFAULT_EAR_THRESHOLD = 0.21;
const CALIBRATION_RATIO = 0.75; // threshold = 75% of baseline open-eye EAR
const PERCLOS_WINDOW_MS = 60_000;
const YAWN_WINDOW_MS = 60_000;
const YAWN_MAR_THRESHOLD = 0.6;
const YAWN_SUSTAIN_MS = 1500;
const NO_FACE_TIMEOUT_MS = 3000;
const BLINK_SCORE_THRESHOLD = 0.5;
const TARGET_FRAME_INTERVAL_MS = 1000 / 15; // >=15 FPS processing target

export class Detector {
  /** @param {HTMLVideoElement} videoEl */
  constructor(videoEl) {
    this.video = videoEl;
    this.landmarker = null;
    this.delegate = 'GPU';
    this.running = false;
    this.rafId = null;
    this.lastFrameTs = 0;

    this.earThreshold = DEFAULT_EAR_THRESHOLD;
    this._calibrating = false;
    this._calibrateCancelled = false;

    // Rolling windows: array of { t: msEpoch, closed: bool }
    this.perclosWindow = [];
    // Yawn events (timestamps, ms epoch) in the last minute.
    this.yawnEvents = [];
    this._yawnActiveSince = null;
    this._yawnCounted = false;

    this.blinkCount = 0;
    this._wasClosed = false;

    this.fps = 0;
    this._frameTimes = [];
  }

  static isSupported() {
    return typeof WebAssembly !== 'undefined';
  }

  /** Loads WASM runtime + model. Tries GPU delegate first, falls back to CPU. */
  async init(onProgress) {
    if (!Detector.isSupported()) {
      throw new Error('WebAssembly not supported on this browser — face detection unavailable.');
    }
    onProgress?.('Loading vision runtime…');
    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    } catch (err) {
      throw new Error('Could not load MediaPipe runtime (check network connection on first run).');
    }

    const tryCreate = async (delegate) => {
      onProgress?.(`Loading face model (${delegate})…`);
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        outputFaceBlendshapes: true,
        runningMode: 'VIDEO',
        numFaces: 1,
      });
    };

    try {
      this.landmarker = await tryCreate('GPU');
      this.delegate = 'GPU';
    } catch (gpuErr) {
      console.warn('[detector] GPU delegate failed, falling back to CPU', gpuErr);
      try {
        this.landmarker = await tryCreate('CPU');
        this.delegate = 'CPU';
      } catch (cpuErr) {
        throw new Error('Could not initialize face detector on GPU or CPU delegate.');
      }
    }
    onProgress?.('Model ready.');
  }

  setEarThreshold(v) {
    this.earThreshold = v;
  }

  /** 5s eyes-open baseline; resolves with the calibrated threshold. Skippable by caller. */
  async calibrate(durationSec = 5, onTick) {
    if (!this.landmarker) throw new Error('Detector not initialized.');
    const samples = [];
    const startedAt = performance.now();
    this._calibrating = true;
    this._calibrateCancelled = false;
    return new Promise((resolve, reject) => {
      const step = () => {
        // Cancelled mid-loop (skip button, or app.js needed the main detection
        // loop back): resolve with the current threshold, unchanged, and stop.
        if (this._calibrateCancelled) {
          this._calibrating = false;
          resolve(this.earThreshold);
          return;
        }
        const elapsed = (performance.now() - startedAt) / 1000;
        if (elapsed >= durationSec) {
          this._calibrating = false;
          if (samples.length === 0) {
            resolve(this.earThreshold); // no face seen; keep default
            return;
          }
          const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
          const threshold = avg * CALIBRATION_RATIO;
          this.earThreshold = threshold;
          resolve(threshold);
          return;
        }
        try {
          const result = this.landmarker.detectForVideo(this.video, performance.now());
          if (result.faceLandmarks && result.faceLandmarks.length > 0) {
            const lm = result.faceLandmarks[0];
            const ear = (computeEAR(lm, LEFT_EYE) + computeEAR(lm, RIGHT_EYE)) / 2;
            samples.push(ear);
          }
          onTick?.(elapsed / durationSec);
        } catch (err) {
          this._calibrating = false;
          reject(err);
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /** Cancel an in-flight calibrate() loop without touching earThreshold. */
  cancelCalibration() {
    this._calibrateCancelled = true;
  }

  /**
   * Starts the detection loop. `onSample` is called once per processed frame with:
   * { eyesClosed, faceDetected, ear, mar, perclos, yawnsPerMin, blinkCount, fps, nowMs }
   */
  start(onSample) {
    if (!this.landmarker) throw new Error('Detector not initialized.');
    this.running = true;

    const loop = (ts) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);

      // Frame skipping to cap processing rate on slow devices.
      if (ts - this.lastFrameTs < TARGET_FRAME_INTERVAL_MS) return;
      this.lastFrameTs = ts;

      // FPS bookkeeping.
      this._frameTimes.push(ts);
      while (this._frameTimes.length && ts - this._frameTimes[0] > 1000) this._frameTimes.shift();
      this.fps = this._frameTimes.length;

      if (this.video.readyState < 2) return; // not enough data yet

      let result;
      try {
        result = this.landmarker.detectForVideo(this.video, ts);
      } catch (err) {
        console.error('[detector] detectForVideo failed', err);
        return;
      }

      const nowMs = Date.now();
      const faceDetected = !!(result.faceLandmarks && result.faceLandmarks.length > 0);

      let ear = null;
      let mar = null;
      let eyesClosed = false;

      if (faceDetected) {
        const lm = result.faceLandmarks[0];
        ear = (computeEAR(lm, LEFT_EYE) + computeEAR(lm, RIGHT_EYE)) / 2;
        mar = computeMAR(lm);
        eyesClosed = ear < this.earThreshold;

        // Secondary signal: blendshape blink scores.
        if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
          const cats = result.faceBlendshapes[0].categories;
          const l = cats.find((c) => c.categoryName === 'eyeBlinkLeft');
          const r = cats.find((c) => c.categoryName === 'eyeBlinkRight');
          if (l && r) {
            const blinkScore = (l.score + r.score) / 2;
            if (blinkScore > BLINK_SCORE_THRESHOLD) eyesClosed = true;
          }
        }

        // Blink counting: rising edge open->closed->open counts one blink on reopen.
        if (this._wasClosed && !eyesClosed) this.blinkCount += 1;
        this._wasClosed = eyesClosed;

        // Yawn detection: MAR > threshold sustained >= 1.5s.
        if (mar > YAWN_MAR_THRESHOLD) {
          if (this._yawnActiveSince === null) {
            this._yawnActiveSince = nowMs;
            this._yawnCounted = false;
          } else if (!this._yawnCounted && nowMs - this._yawnActiveSince >= YAWN_SUSTAIN_MS) {
            this.yawnEvents.push(nowMs);
            this._yawnLifetime = (this._yawnLifetime || 0) + 1;
            this._yawnCounted = true;
          }
        } else {
          this._yawnActiveSince = null;
          this._yawnCounted = false;
        }
      } else {
        this._wasClosed = false;
        this._yawnActiveSince = null;
      }

      // PERCLOS rolling window (proxy: fraction of frames with eyesClosed true).
      this.perclosWindow.push({ t: nowMs, closed: eyesClosed });
      while (this.perclosWindow.length && nowMs - this.perclosWindow[0].t > PERCLOS_WINDOW_MS) {
        this.perclosWindow.shift();
      }
      const perclos = this.perclosWindow.length
        ? (100 * this.perclosWindow.filter((s) => s.closed).length) / this.perclosWindow.length
        : 0;
      // Actual span covered by the window so far — lets the FSM ignore PERCLOS
      // as a critical signal until it's had time to accumulate enough samples.
      const perclosWindowSpanMs = this.perclosWindow.length ? nowMs - this.perclosWindow[0].t : 0;

      // Yawn rate per minute (rolling 60s window == direct per-minute count).
      while (this.yawnEvents.length && nowMs - this.yawnEvents[0] > YAWN_WINDOW_MS) {
        this.yawnEvents.shift();
      }
      const yawnsPerMin = this.yawnEvents.length;

      onSample({
        eyesClosed,
        faceDetected,
        ear,
        mar,
        perclos,
        perclosWindowSpanMs,
        yawnsPerMin,
        yawnTotal: this._yawnTotalCount(),
        blinkCount: this.blinkCount,
        fps: this.fps,
        delegate: this.delegate,
        nowMs: ts,
        noFaceTimeoutMs: NO_FACE_TIMEOUT_MS,
      });
    };

    this.rafId = requestAnimationFrame(loop);
  }

  _yawnTotalCount() {
    // yawnEvents is trimmed to a 60s rolling window for rate purposes; a
    // separate lifetime counter (incremented alongside it) covers the session summary.
    return this._yawnLifetime || 0;
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  resetSessionCounters() {
    this.perclosWindow = [];
    this.yawnEvents = [];
    this._yawnActiveSince = null;
    this._yawnCounted = false;
    this.blinkCount = 0;
    this._wasClosed = false;
    this._yawnLifetime = 0;
  }

  close() {
    this.stop();
    this.landmarker?.close?.();
    this.landmarker = null;
  }
}
