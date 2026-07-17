// dashboard.js — live stats, event log, session summary, history chart, CSV export.
// Replaces the original Arduino Cloud IoT dashboard.

import { PAPER_BENCHMARKS } from './metrics.js';
import { getSessions, clearSessions } from './storage.js';

function fmtSec(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)}s`;
}

function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)}%`;
}

export class Dashboard {
  /**
   * @param {{ liveRoot: HTMLElement, logRoot: HTMLElement, summaryRoot: HTMLElement,
   *           historyRoot: HTMLElement, chartCanvas: HTMLCanvasElement, csvBtn: HTMLElement }} els
   */
  constructor(els) {
    this.els = els;
    this._log = [];
    if (this.els.csvBtn) {
      this.els.csvBtn.addEventListener('click', () => this.exportCsv());
    }
    this.renderHistory();
  }

  // ---- Live tiles ----
  updateLive({ state, perclos, blinkRate, yawnCount, durationSec, fps }) {
    if (!this.els.liveRoot) return;
    const tiles = [
      ['State', state],
      ['PERCLOS', fmtPct(perclos)],
      ['Blink rate/min', blinkRate ?? '—'],
      ['Yawns', yawnCount ?? 0],
      ['Duration', formatDuration(durationSec)],
      ['FPS', fps ?? '—'],
    ];
    this.els.liveRoot.innerHTML = tiles
      .map(([label, value]) => `
        <div class="stat-tile">
          <span class="stat-tile__label">${label}</span>
          <span class="stat-tile__value">${value}</span>
        </div>`)
      .join('');
  }

  // ---- Event log ----
  logEvent(label, meta = '') {
    const entry = { t: new Date(), label, meta };
    this._log.unshift(entry);
    if (this._log.length > 200) this._log.pop();
    this.renderLog();
  }

  renderLog() {
    if (!this.els.logRoot) return;
    if (this._log.length === 0) {
      this.els.logRoot.innerHTML = '<p class="empty-state">No events yet — start a session.</p>';
      return;
    }
    this.els.logRoot.innerHTML = this._log
      .map((e) => `<div class="log-row"><span class="log-row__time">${e.t.toLocaleTimeString()}</span><span class="log-row__label">${e.label}</span><span class="log-row__meta">${e.meta}</span></div>`)
      .join('');
  }

  clearLog() {
    this._log = [];
    this.renderLog();
  }

  // ---- Session summary (on stop) ----
  renderSummary(session) {
    if (!this.els.summaryRoot) return;
    const rows = [
      ['Mobile alert latency', session.latencies?.alertMean, PAPER_BENCHMARKS.alert],
      ['Assistant activation latency', session.latencies?.activationMean, PAPER_BENCHMARKS.activation],
      ['Conversational turn-taking', session.latencies?.turnTakingMean, PAPER_BENCHMARKS.turnTaking],
    ];
    this.els.summaryRoot.innerHTML = `
      <div class="summary-grid">
        <div class="stat-tile"><span class="stat-tile__label">Duration</span><span class="stat-tile__value">${formatDuration(session.durationSec)}</span></div>
        <div class="stat-tile"><span class="stat-tile__label">PERCLOS max</span><span class="stat-tile__value">${fmtPct(session.perclosMax)}</span></div>
        <div class="stat-tile"><span class="stat-tile__label">Yawns</span><span class="stat-tile__value">${session.yawnCount ?? 0}</span></div>
        <div class="stat-tile"><span class="stat-tile__label">Warnings</span><span class="stat-tile__value">${session.warningCount ?? 0}</span></div>
        <div class="stat-tile"><span class="stat-tile__label">Criticals</span><span class="stat-tile__value">${session.criticalCount ?? 0}</span></div>
      </div>
      <table class="benchmark-table">
        <thead><tr><th>Metric</th><th>This session (mean)</th><th>Paper mean</th></tr></thead>
        <tbody>
          ${rows.map(([label, mean, bench]) => `<tr><td>${label}</td><td>${fmtSec(mean)}</td><td>${fmtSec(bench)}</td></tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  // ---- History (past sessions) ----
  renderHistory() {
    if (!this.els.historyRoot) return;
    const sessions = getSessions();
    if (sessions.length === 0) {
      this.els.historyRoot.innerHTML = '<p class="empty-state">No past sessions yet.</p>';
      this.drawChart([]);
      return;
    }
    this.els.historyRoot.innerHTML = sessions
      .slice(0, 20)
      .map((s) => `
        <div class="history-row">
          <span>${new Date(s.startedAt).toLocaleString()}</span>
          <span>${formatDuration(s.durationSec)}</span>
          <span>${s.warningCount || 0} warn / ${s.criticalCount || 0} crit</span>
        </div>`)
      .join('');
    this.drawChart(sessions.slice(0, 10).reverse());
  }

  clearHistory() {
    clearSessions();
    this.renderHistory();
  }

  drawChart(sessions) {
    const canvas = this.els.chartCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const styles = getComputedStyle(document.documentElement);
    const border = styles.getPropertyValue('--border').trim() || '#334155';
    const warn = styles.getPropertyValue('--warn').trim() || '#FBBF24';
    const critical = styles.getPropertyValue('--critical').trim() || '#F87171';
    const textMuted = styles.getPropertyValue('--text-muted').trim() || '#94A3B8';

    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(30, h - 20);
    ctx.lineTo(w - 10, h - 20);
    ctx.stroke();

    if (sessions.length === 0) {
      ctx.fillStyle = textMuted;
      ctx.font = '12px "Space Mono", monospace';
      ctx.fillText('No session data yet', 30, h / 2);
      return;
    }

    const maxEvents = Math.max(1, ...sessions.map((s) => (s.warningCount || 0) + (s.criticalCount || 0)));
    const barAreaW = w - 50;
    const barW = Math.max(8, barAreaW / (sessions.length * 2.2));

    sessions.forEach((s, i) => {
      const x = 40 + i * (barAreaW / sessions.length);
      const warnH = ((s.warningCount || 0) / maxEvents) * (h - 40);
      const critH = ((s.criticalCount || 0) / maxEvents) * (h - 40);

      ctx.fillStyle = warn;
      ctx.fillRect(x, h - 20 - warnH, barW, warnH);

      ctx.fillStyle = critical;
      ctx.fillRect(x + barW + 2, h - 20 - critH, barW, critH);
    });

    ctx.fillStyle = textMuted;
    ctx.font = '10px "Space Mono", monospace';
    ctx.fillText('warn', 30, 12);
    ctx.fillStyle = warn;
    ctx.fillRect(58, 5, 8, 8);
    ctx.fillStyle = textMuted;
    ctx.fillText('crit', 80, 12);
    ctx.fillStyle = critical;
    ctx.fillRect(102, 5, 8, 8);
  }

  // ---- CSV export ----
  exportCsv() {
    const sessions = getSessions();
    if (sessions.length === 0) {
      alert('No session data to export yet.');
      return;
    }
    const header = [
      'session_id', 'started_at', 'ended_at', 'duration_sec', 'perclos_max',
      'blink_count', 'yawn_count', 'warning_count', 'critical_count',
      'alert_latency_mean', 'activation_latency_mean', 'turn_taking_latency_mean',
    ];
    const rows = sessions.map((s) => [
      s.id, new Date(s.startedAt).toISOString(), s.endedAt ? new Date(s.endedAt).toISOString() : '',
      s.durationSec ?? '', s.perclosMax ?? '', s.blinkCount ?? '', s.yawnCount ?? '',
      s.warningCount ?? '', s.criticalCount ?? '',
      s.latencies?.alertMean ?? '', s.latencies?.activationMean ?? '', s.latencies?.turnTakingMean ?? '',
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gopal_sessions_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
