// app.js — screen router, boot sequence, wake lock, orientation handling, and the
// orchestration glue that wires camera + detector + fsm + assistant + alerts +
// dashboard + storage + metrics together.

import { CameraManager } from './camera.js';
import { Detector } from './detector.js';
import { DrowsinessFSM, STATE } from './fsm.js';
import { Assistant } from './assistant.js';
import { BeepPlayer, getCurrentLocation, sendTelegramAlert, buildAlertMessage, buildSmsLink } from './alerts.js';
import { Dashboard } from './dashboard.js';
import { MetricsLog } from './metrics.js';
import * as storage from './storage.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  unsupportedBanner: $('unsupported-banner'),
  onlineIndicator: $('online-indicator'),

  navButtons: Array.from(document.querySelectorAll('.nav-btn')),
  screens: Array.from(document.querySelectorAll('.screen')),

  video: $('camera-feed'),
  monitorPlaceholder: $('monitor-placeholder'),
  statusBanner: $('status-banner'),
  statusIcon: $('status-icon'),
  statusText: $('status-text'),
  statusSub: $('status-sub'),
  micIndicator: $('mic-indicator'),
  earReadout: $('ear-readout'),
  perclosReadout: $('perclos-readout'),
  fpsReadout: $('fps-readout'),
  assistantCaption: $('assistant-caption'),
  smsAlertBtn: $('sms-alert-btn'),
  sessionBtn: $('session-btn'),

  liveTiles: $('live-tiles'),
  eventLog: $('event-log'),
  sessionSummary: $('session-summary'),
  historyChart: $('history-chart'),
  sessionHistory: $('session-history'),
  csvExportBtn: $('csv-export-btn'),
  clearHistoryBtn: $('clear-history-btn'),

  driverName: $('driver-name'),
  calibrateBtn: $('calibrate-btn'),
  calibrationStatus: $('calibration-status'),
  sttLang: $('stt-lang'),
  ttsRate: $('tts-rate'),
  volume: $('volume'),
  llmProvider: $('llm-provider'),
  geminiKeyField: $('gemini-key-field'),
  geminiKey: $('gemini-key'),
  claudeKeyField: $('claude-key-field'),
  claudeKey: $('claude-key'),
  telegramToken: $('telegram-token'),
  telegramChatId: $('telegram-chatid'),
  testTelegramBtn: $('test-telegram-btn'),
  telegramTestResult: $('telegram-test-result'),
  wakeLockToggle: $('wake-lock-toggle'),
  reducedMotionToggle: $('reduced-motion-toggle'),

  contactList: $('contact-list'),
  addContactForm: $('add-contact-form'),
  contactName: $('contact-name'),
  contactPhone: $('contact-phone'),

  toast: $('toast'),
  permissionOverlay: $('permission-overlay'),
  permissionContinueBtn: $('permission-continue-btn'),
  permissionCancelBtn: $('permission-cancel-btn'),
  calibrationOverlay: $('calibration-overlay'),
  calibrationBar: $('calibration-bar'),
  calibrationSkipBtn: $('calibration-skip-btn'),
};

const STATUS_ICON_PATHS = {
  [STATE.ALERT]: '<circle cx="12" cy="12" r="9"></circle><path d="M9 12l2 2 4-4"></path>',
  [STATE.WARNING]: '<path d="M12 2 1 21h22L12 2z"></path><path d="M12 9v5"></path><path d="M12 17.5v.01"></path>',
  [STATE.CRITICAL]: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6"></path><path d="M12 16.5v.01"></path>',
};

const STATUS_SUB = {
  [STATE.ALERT]: 'Looking good',
  [STATE.WARNING]: 'Eyes closing — check in',
  [STATE.CRITICAL]: 'Critical drowsy — pull over',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let camera = null;
let detector = null;
let fsm = null;
let assistant = null;
let beepPlayer = null;
let dashboard = null;
let metrics = null;

let sessionActive = false;
let sessionStartedAt = null;
let wakeLockSentinel = null;
let assistantBusy = false;

let sessionStats = { blinkCount: 0, yawnCount: 0, perclosMax: 0, warningCount: 0, criticalCount: 0 };
let latestSample = null;

// ===========================================================================
// Feature detection
// ===========================================================================

function checkFeatureSupport() {
  const missing = [];
  if (!CameraManager.isSupported()) missing.push('camera (getUserMedia)');
  if (!Detector.isSupported()) missing.push('WebAssembly');
  if (missing.length) {
    els.unsupportedBanner.textContent = `This browser is missing required features: ${missing.join(', ')}. Try Chrome on Android.`;
    els.unsupportedBanner.classList.add('unsupported-banner--visible');
    els.sessionBtn.disabled = true;
    return false;
  }
  return true;
}

// ===========================================================================
// Screen router
// ===========================================================================

function showScreen(name) {
  els.screens.forEach((s) => s.classList.toggle('screen--active', s.dataset.screen === name));
  els.navButtons.forEach((b) => b.setAttribute('aria-current', String(b.dataset.screen === name)));
  if (name === 'dashboard') dashboard?.renderHistory();
}

function initNav() {
  els.navButtons.forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });
}

// ===========================================================================
// Toast
// ===========================================================================

let toastTimer = null;
function showToast(msg, duration = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('toast--visible'), duration);
}

// ===========================================================================
// Settings form <-> storage
// ===========================================================================

function applySettingsToForm(settings) {
  els.driverName.value = settings.driverName || '';
  els.sttLang.value = settings.sttLang || 'en-US';
  els.ttsRate.value = settings.ttsRate ?? 1.0;
  els.volume.value = settings.volume ?? 0.8;
  els.llmProvider.value = settings.llmProvider || 'none';
  els.geminiKey.value = settings.geminiKey || '';
  els.claudeKey.value = settings.claudeKey || '';
  els.telegramToken.value = settings.telegramToken || '';
  els.telegramChatId.value = settings.telegramChatId || '';
  els.wakeLockToggle.checked = settings.wakeLock !== false;
  els.reducedMotionToggle.checked = !!settings.reducedMotion;
  updateCalibrationStatus(settings);
  updateLlmFieldVisibility();
}

function updateCalibrationStatus(settings) {
  els.calibrationStatus.textContent = settings.calibrated && typeof settings.earThreshold === 'number'
    ? `Calibrated — threshold ${settings.earThreshold.toFixed(3)}`
    : 'Not calibrated — using default threshold.';
}

function updateLlmFieldVisibility() {
  const provider = els.llmProvider.value;
  els.geminiKeyField.style.display = provider === 'gemini' ? '' : 'none';
  els.claudeKeyField.style.display = provider === 'claude' ? '' : 'none';
}

function initSettingsForm() {
  const settings = storage.getSettings();
  applySettingsToForm(settings);
  document.documentElement.classList.toggle('reduced-motion-forced', !!settings.reducedMotion);

  const persist = (partial) => {
    storage.saveSettings(partial);
    showToast('Settings saved');
  };

  els.driverName.addEventListener('change', () => persist({ driverName: els.driverName.value.trim() }));
  els.sttLang.addEventListener('change', () => {
    persist({ sttLang: els.sttLang.value });
    assistant?.updateConfig({ lang: els.sttLang.value });
  });
  els.ttsRate.addEventListener('change', () => {
    persist({ ttsRate: parseFloat(els.ttsRate.value) });
    assistant?.updateConfig({ ttsRate: parseFloat(els.ttsRate.value) });
  });
  els.volume.addEventListener('change', () => {
    persist({ volume: parseFloat(els.volume.value) });
    assistant?.updateConfig({ volume: parseFloat(els.volume.value) });
  });
  els.llmProvider.addEventListener('change', () => {
    updateLlmFieldVisibility();
    persist({ llmProvider: els.llmProvider.value });
    assistant?.updateConfig({ provider: els.llmProvider.value });
  });
  els.geminiKey.addEventListener('change', () => {
    persist({ geminiKey: els.geminiKey.value.trim() });
    assistant?.updateConfig({ geminiKey: els.geminiKey.value.trim() });
  });
  els.claudeKey.addEventListener('change', () => {
    persist({ claudeKey: els.claudeKey.value.trim() });
    assistant?.updateConfig({ claudeKey: els.claudeKey.value.trim() });
  });
  els.telegramToken.addEventListener('change', () => persist({ telegramToken: els.telegramToken.value.trim() }));
  els.telegramChatId.addEventListener('change', () => persist({ telegramChatId: els.telegramChatId.value.trim() }));
  els.wakeLockToggle.addEventListener('change', () => persist({ wakeLock: els.wakeLockToggle.checked }));
  els.reducedMotionToggle.addEventListener('change', () => {
    persist({ reducedMotion: els.reducedMotionToggle.checked });
    document.documentElement.classList.toggle('reduced-motion-forced', els.reducedMotionToggle.checked);
  });

  document.querySelectorAll('[data-toggle-visibility]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.toggleVisibility);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
    });
  });

  els.calibrateBtn.addEventListener('click', runCalibrationFlow);

  els.testTelegramBtn.addEventListener('click', async () => {
    els.telegramTestResult.textContent = 'Sending…';
    const s = storage.getSettings();
    const result = await sendTelegramAlert({
      token: s.telegramToken,
      chatId: s.telegramChatId,
      text: `GoPal test alert — if you see this, alerts are working. (${new Date().toLocaleTimeString()})`,
    });
    els.telegramTestResult.textContent = result.ok ? 'Sent! Check Telegram.' : `Failed: ${result.error || 'HTTP ' + result.status}`;
  });
}

// ===========================================================================
// Contacts
// ===========================================================================

function renderContacts() {
  const contacts = storage.getContacts();
  if (contacts.length === 0) {
    els.contactList.innerHTML = '<p class="empty-state">No emergency contacts yet — add one below.</p>';
    return;
  }
  els.contactList.innerHTML = contacts
    .map((c) => `
      <div class="contact-row">
        <span class="contact-row__info">
          <span class="contact-row__name">${escapeHtml(c.name)}</span>
          <span class="contact-row__phone">${escapeHtml(c.phone)}</span>
        </span>
        <button class="btn btn--sm btn--ghost" data-remove-contact="${c.id}" type="button">Remove</button>
      </div>`)
    .join('');
  els.contactList.querySelectorAll('[data-remove-contact]').forEach((btn) => {
    btn.addEventListener('click', () => {
      storage.removeContact(btn.dataset.removeContact);
      renderContacts();
      showToast('Contact removed');
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initContacts() {
  renderContacts();
  els.addContactForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.contactName.value.trim();
    const phone = els.contactPhone.value.trim();
    if (!name || !phone) return;
    storage.addContact({ name, phone });
    els.addContactForm.reset();
    renderContacts();
    showToast('Contact added');
  });
}

// ===========================================================================
// Wake Lock
// ===========================================================================

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const settings = storage.getSettings();
  if (!settings.wakeLock) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
  } catch (err) {
    console.warn('[app] wake lock request failed', err);
  }
}

function releaseWakeLock() {
  wakeLockSentinel?.release().catch(() => {});
  wakeLockSentinel = null;
}

document.addEventListener('visibilitychange', () => {
  if (sessionActive && document.visibilityState === 'visible' && !wakeLockSentinel) {
    acquireWakeLock();
  }
});

// ===========================================================================
// Permission explainer flow
// ===========================================================================

function requestPermissionsFlow() {
  return new Promise((resolve) => {
    els.permissionOverlay.classList.add('overlay--visible');
    const cleanup = () => els.permissionOverlay.classList.remove('overlay--visible');
    els.permissionContinueBtn.onclick = () => { cleanup(); resolve(true); };
    els.permissionCancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
}

async function acquireDevicePermissions() {
  const results = { camera: false, mic: false, location: false };

  try {
    await camera.start();
    results.camera = true;
  } catch (err) {
    showToast(err.message);
    return results;
  }

  // Prime mic permission early (STT will reuse the grant); stop tracks immediately.
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStream.getTracks().forEach((t) => t.stop());
    results.mic = true;
  } catch (err) {
    console.warn('[app] mic permission not granted, voice check-ins disabled', err);
  }

  try {
    await getCurrentLocation(6000);
    results.location = true;
  } catch (err) {
    console.warn('[app] location permission not granted, alerts will omit GPS', err);
  }

  return results;
}

// ===========================================================================
// Calibration
// ===========================================================================

async function runCalibrationFlow() {
  if (!detector || !detector.landmarker) {
    // Standalone calibration from Settings needs its own camera+detector instance.
    showToast('Start a session first, or use the in-session calibration prompt.');
    return;
  }
  await calibrateNow();
}

async function calibrateNow() {
  // Recalibrating mid-session would otherwise run calibrate()'s rAF loop
  // concurrently with the main detection loop — two detectForVideo calls per
  // frame on one landmarker, which can throw (MediaPipe VIDEO mode requires
  // monotonically increasing timestamps). Pause the main loop for the
  // duration of calibration and only resume it if a session is still active
  // (first-session calibration runs before detector.start(), so there's
  // nothing to restart there).
  const wasRunning = detector.running;
  if (wasRunning) detector.stop();

  els.calibrationOverlay.classList.add('overlay--visible');
  els.calibrationBar.style.width = '0%';

  await new Promise((resolve) => {
    let skipped = false;
    els.calibrationSkipBtn.onclick = () => {
      skipped = true;
      detector.cancelCalibration();
      els.calibrationOverlay.classList.remove('overlay--visible');
      resolve();
    };

    detector
      .calibrate(5, (progress) => {
        if (!skipped) els.calibrationBar.style.width = `${Math.min(100, progress * 100)}%`;
      })
      .then((threshold) => {
        if (skipped) return;
        els.calibrationOverlay.classList.remove('overlay--visible');
        storage.saveSettings({ calibrated: true, earThreshold: threshold });
        updateCalibrationStatus(storage.getSettings());
        resolve();
      })
      .catch((err) => {
        console.warn('[app] calibration failed', err);
        els.calibrationOverlay.classList.remove('overlay--visible');
        resolve();
      });
  });

  if (wasRunning && sessionActive) detector.start(onDetectorSample);
}

// ===========================================================================
// Session lifecycle
// ===========================================================================

async function startSession() {
  const proceed = await requestPermissionsFlow();
  if (!proceed) return;

  els.sessionBtn.disabled = true;
  els.sessionBtn.textContent = 'Starting…';

  camera = camera || new CameraManager(els.video);
  const perms = await acquireDevicePermissions();
  if (!perms.camera) {
    els.sessionBtn.disabled = false;
    els.sessionBtn.textContent = 'Start Session';
    return;
  }
  els.monitorPlaceholder.style.display = 'none';

  detector = detector || new Detector(els.video);
  try {
    if (!detector.landmarker) {
      els.statusSub.textContent = 'Loading face model…';
      await detector.init((msg) => { els.statusSub.textContent = msg; });
    }
  } catch (err) {
    showToast(err.message);
    camera.stop();
    els.sessionBtn.disabled = false;
    els.sessionBtn.textContent = 'Start Session';
    return;
  }

  const settings = storage.getSettings();
  detector.setEarThreshold(settings.earThreshold || 0.21);
  if (!settings.calibrated) {
    await calibrateNow();
  }

  detector.resetSessionCounters();
  fsm = new DrowsinessFSM();
  fsm.addEventListener('transition', onFsmTransition);

  assistant = new Assistant({
    provider: settings.llmProvider,
    geminiKey: settings.geminiKey,
    claudeKey: settings.claudeKey,
    lang: settings.sttLang,
    ttsRate: settings.ttsRate,
    volume: settings.volume,
  });

  beepPlayer = beepPlayer || new BeepPlayer();
  metrics = new MetricsLog();
  sessionStats = { blinkCount: 0, yawnCount: 0, perclosMax: 0, warningCount: 0, criticalCount: 0 };
  latestSample = null;

  await acquireWakeLock();

  sessionActive = true;
  sessionStartedAt = Date.now();
  dashboard.clearLog();
  dashboard.logEvent('Session started');
  metrics.log('session', 'started');

  els.smsAlertBtn.classList.remove('sms-alert-btn--visible');
  els.sessionBtn.disabled = false;
  els.sessionBtn.textContent = 'Stop Session';
  els.sessionBtn.classList.add('btn--danger');

  detector.start(onDetectorSample);
  liveUpdateTimer = setInterval(refreshLiveTiles, 1000);
}

let liveUpdateTimer = null;

function stopSession() {
  sessionActive = false;
  detector?.stop();
  camera?.stop();
  releaseWakeLock();
  clearInterval(liveUpdateTimer);
  beepPlayer?.stopCritical();
  assistant?.interrupt();

  els.monitorPlaceholder.style.display = '';
  els.smsAlertBtn.classList.remove('sms-alert-btn--visible');
  els.sessionBtn.textContent = 'Start Session';
  els.sessionBtn.classList.remove('btn--danger');

  const durationSec = sessionStartedAt ? (Date.now() - sessionStartedAt) / 1000 : 0;
  const metricsSummary = metrics ? metrics.summary() : {};
  const session = {
    id: `s_${sessionStartedAt}`,
    startedAt: sessionStartedAt,
    endedAt: Date.now(),
    durationSec,
    perclosMax: sessionStats.perclosMax,
    blinkCount: latestSample?.blinkCount ?? sessionStats.blinkCount,
    yawnCount: latestSample?.yawnTotal ?? sessionStats.yawnCount,
    warningCount: sessionStats.warningCount,
    criticalCount: sessionStats.criticalCount,
    latencies: {
      alertMean: metricsSummary.alertMean,
      activationMean: metricsSummary.activationMean,
      turnTakingMean: metricsSummary.turnTakingMean,
    },
  };
  storage.saveSession(session);
  dashboard.logEvent('Session stopped', formatDurationShort(durationSec));
  dashboard.renderSummary(session);
  dashboard.renderHistory();

  setStatusBanner(STATE.ALERT, 'Session not started');
  els.earReadout.textContent = '—';
  els.perclosReadout.textContent = '—';
  els.fpsReadout.textContent = '—';
  els.assistantCaption.textContent = 'GoPal will check in here during a session.';

  fsm?.reset();
  sessionStartedAt = null;
}

els.sessionBtn.addEventListener('click', () => {
  if (sessionActive) stopSession();
  else startSession();
});

// ===========================================================================
// Detector sample -> UI + FSM feed
// ===========================================================================

function onDetectorSample(sample) {
  latestSample = sample;
  if (!sessionActive) return;

  els.earReadout.textContent = sample.ear !== null ? sample.ear.toFixed(3) : '—';
  els.perclosReadout.textContent = `${sample.perclos.toFixed(0)}%`;
  els.fpsReadout.textContent = String(sample.fps);

  sessionStats.perclosMax = Math.max(sessionStats.perclosMax, sample.perclos);

  fsm.update(sample);
}

function refreshLiveTiles() {
  if (!sessionActive || !latestSample) return;
  const durationSec = sessionStartedAt ? (Date.now() - sessionStartedAt) / 1000 : 0;
  const blinkRate = durationSec > 0 ? Math.round((latestSample.blinkCount / durationSec) * 60) : 0;
  dashboard.updateLive({
    state: fsm.state,
    perclos: latestSample.perclos,
    blinkRate,
    yawnCount: latestSample.yawnTotal,
    durationSec,
    fps: latestSample.fps,
  });
}

function formatDurationShort(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s}s`;
}

// ===========================================================================
// FSM transitions -> alerts + assistant + dashboard + metrics
// ===========================================================================

function setStatusBanner(state, subOverride) {
  els.statusBanner.className = `status-banner status-banner--${state.toLowerCase()}`;
  els.statusIcon.innerHTML = STATUS_ICON_PATHS[state];
  els.statusText.textContent = state === STATE.ALERT ? 'ALERT' : state === STATE.WARNING ? 'WARNING' : 'CRITICAL DROWSY';
  els.statusSub.textContent = subOverride ?? STATUS_SUB[state];
}

async function onFsmTransition(evt) {
  const { to, reason } = evt.detail;
  setStatusBanner(to);
  dashboard.logEvent(`State -> ${to}`, reason);
  metrics.log('transition', to, { reason });

  if (to === STATE.WARNING) {
    sessionStats.warningCount += 1;
    metrics.markStart('activation');
    beepPlayer.playWarning(storage.getSettings().volume);
    beepPlayer.stopCritical();
    runAssistantTurn('activation');
  } else if (to === STATE.CRITICAL) {
    sessionStats.criticalCount += 1;
    metrics.markStart('alert');
    beepPlayer.playCritical(storage.getSettings().volume);
    triggerCriticalAlerts();
    runAssistantTurn(null);
  } else if (to === STATE.ALERT) {
    beepPlayer.stopCritical();
    els.smsAlertBtn.classList.remove('sms-alert-btn--visible');
  }
}

async function runAssistantTurn(activationMetricKey) {
  if (assistantBusy || !assistant) return;
  assistantBusy = true;
  els.micIndicator.classList.add('mic-indicator--active');
  try {
    // Latency semantics mirror the paper's Response Time Test:
    //   activation  = WARNING trigger -> assistant's first spoken word
    //   turnTaking  = driver finishes replying -> assistant's reply starts
    const result = await assistant.runTurn(null, {
      onFirstWord: () => {
        if (activationMetricKey) metrics.markEnd('activation', 'activation');
      },
      onReplyHeard: () => metrics.markStart('turnTaking'),
      onReplyStart: () => metrics.markEnd('turnTaking', 'turnTaking'),
    });

    els.assistantCaption.textContent = result.heard
      ? `GoPal: "${result.spoken}" — You: "${result.heard}"`
      : `GoPal: "${result.spoken}" (no reply heard)`;
    dashboard.logEvent('Assistant turn', result.source);

    if (result.heard && fsm) {
      fsm.registerVocalResponse();
    }
  } catch (err) {
    console.warn('[app] assistant turn failed', err);
  } finally {
    assistantBusy = false;
    els.micIndicator.classList.remove('mic-indicator--active');
  }
}

async function triggerCriticalAlerts() {
  const settings = storage.getSettings();

  let locationLink = null;
  try {
    const loc = await getCurrentLocation(6000);
    locationLink = loc.link;
  } catch (err) {
    console.warn('[app] location fetch failed for alert', err.message);
  }

  const text = buildAlertMessage({ driverName: settings.driverName, locationLink });
  const result = await sendTelegramAlert({ token: settings.telegramToken, chatId: settings.telegramChatId, text });
  if (result.ok) {
    metrics.markEnd('alert', 'alert');
  } else {
    // Unconfigured/failed send — don't let a no-op or the 6s location timeout
    // pollute the alert latency stat.
    metrics.cancel('alert');
  }
  dashboard.logEvent('Telegram alert', result.ok ? 'sent' : `failed: ${result.error || result.status}`);

  const contacts = storage.getContacts();
  if (contacts.length > 0) {
    const smsBody = text + (locationLink ? '' : '');
    els.smsAlertBtn.href = buildSmsLink(contacts.map((c) => c.phone), smsBody);
    els.smsAlertBtn.classList.add('sms-alert-btn--visible');
  }
}

// ===========================================================================
// Online indicator
// ===========================================================================

function updateOnlineIndicator() {
  els.onlineIndicator.textContent = navigator.onLine ? '● online' : '○ offline';
  els.onlineIndicator.style.color = navigator.onLine ? 'var(--ok)' : 'var(--text-muted)';
  els.onlineIndicator.style.fontSize = '0.65rem';
}
window.addEventListener('online', updateOnlineIndicator);
window.addEventListener('offline', updateOnlineIndicator);

// ===========================================================================
// Service worker registration
// ===========================================================================

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js');
  } catch (err) {
    console.warn('[app] service worker registration failed', err);
  }
}

// ===========================================================================
// Boot
// ===========================================================================

function boot() {
  checkFeatureSupport();
  initNav();
  initSettingsForm();
  initContacts();
  updateOnlineIndicator();
  registerServiceWorker();

  dashboard = new Dashboard({
    liveRoot: els.liveTiles,
    logRoot: els.eventLog,
    summaryRoot: els.sessionSummary,
    historyRoot: els.sessionHistory,
    chartCanvas: els.historyChart,
    csvBtn: els.csvExportBtn,
  });
  els.clearHistoryBtn.addEventListener('click', () => {
    dashboard.clearHistory();
    showToast('History cleared');
  });

  setStatusBanner(STATE.ALERT, 'Session not started');
}

document.addEventListener('DOMContentLoaded', boot);
