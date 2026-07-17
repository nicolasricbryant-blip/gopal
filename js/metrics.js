// metrics.js — response-time instrumentation mirroring the original paper's benchmarks.
// Paper means: mobile alert 3.98s, assistant activation 2.48s, conversational turn-taking 2.76s.

export const PAPER_BENCHMARKS = {
  alert: 3.98,
  activation: 2.48,
  turnTaking: 2.76,
};

/**
 * Tracks timestamped instrumentation events for a single session and derives
 * latency series for the three metrics the paper reports.
 */
export class MetricsLog {
  constructor() {
    this.events = [];        // { t, type, label, meta }
    this.pending = new Map(); // key -> startTime, for open latency measurements
    this.latencies = {
      alert: [],
      activation: [],
      turnTaking: [],
    };
    this.startedAt = Date.now();
  }

  log(type, label, meta = {}) {
    const entry = { t: Date.now(), type, label, meta };
    this.events.push(entry);
    return entry;
  }

  // Call when a timed interval begins (e.g. drowsy state detected).
  markStart(key) {
    this.pending.set(key, performance.now());
  }

  // Call when the interval ends; records the latency (seconds) under `metric`.
  markEnd(key, metric) {
    const start = this.pending.get(key);
    if (start === undefined) return null;
    const elapsedSec = (performance.now() - start) / 1000;
    this.pending.delete(key);
    if (metric && this.latencies[metric]) {
      this.latencies[metric].push(elapsedSec);
    }
    return elapsedSec;
  }

  // Call to discard a pending interval without recording a latency sample —
  // e.g. the alert send was skipped or failed, so the elapsed time would
  // pollute the mean with a no-op or a timeout duration instead of real latency.
  cancel(key) {
    this.pending.delete(key);
  }

  mean(arr) {
    if (!arr || arr.length === 0) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  summary() {
    return {
      alertMean: this.mean(this.latencies.alert),
      activationMean: this.mean(this.latencies.activation),
      turnTakingMean: this.mean(this.latencies.turnTaking),
      alertSamples: this.latencies.alert.length,
      activationSamples: this.latencies.activation.length,
      turnTakingSamples: this.latencies.turnTaking.length,
      benchmarks: PAPER_BENCHMARKS,
    };
  }

  exportEvents() {
    return this.events.map((e) => ({ ...e, tISO: new Date(e.t).toISOString() }));
  }
}
