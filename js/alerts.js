// alerts.js — WebAudio beep patterns, GPS fetch, Telegram push, SMS deep-link.

/** Builds a Google Maps link from a geolocation position. */
function mapsLink(lat, lng) {
  return `https://maps.google.com/?q=${lat},${lng}`;
}

/** Wraps navigator.geolocation in a promise with a sane timeout. */
export function getCurrentLocation(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation not supported on this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, link: mapsLink(pos.coords.latitude, pos.coords.longitude) }),
      (err) => reject(new Error(`Location unavailable: ${err.message}`)),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15000 }
    );
  });
}

// ---- Audio alerts ----

export class BeepPlayer {
  constructor() {
    this.ctx = null;
    this._sweepTimer = null;
  }

  _ensureCtx() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error('WebAudio not supported.');
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  _tone(freq, startAt, durationSec, gainValue) {
    const ctx = this._ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(gainValue, startAt + 0.02);
    gain.gain.linearRampToValueAtTime(0, startAt + durationSec);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durationSec + 0.02);
  }

  /** WARNING: 880Hz double-pulse. */
  playWarning(volume = 0.8) {
    try {
      const ctx = this._ensureCtx();
      const now = ctx.currentTime;
      this._tone(880, now, 0.18, volume * 0.5);
      this._tone(880, now + 0.28, 0.18, volume * 0.5);
    } catch (err) {
      console.warn('[alerts] beep failed', err);
    }
  }

  /** CRITICAL: continuous rising/falling sweep pattern until stopCritical() is called. */
  playCritical(volume = 0.9) {
    try {
      const ctx = this._ensureCtx();
      this.stopCritical();
      const pulse = () => {
        const now = ctx.currentTime;
        this._tone(660, now, 0.14, volume * 0.6);
        this._tone(990, now + 0.16, 0.14, volume * 0.6);
      };
      pulse();
      this._sweepTimer = setInterval(pulse, 380);
    } catch (err) {
      console.warn('[alerts] critical beep failed', err);
    }
  }

  stopCritical() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }
}

// ---- Telegram (automatic channel) ----

/**
 * Sends a Telegram message via the Bot API GET endpoint.
 * Returns { ok, status, error? }. Never throws — callers log the result.
 */
export async function sendTelegramAlert({ token, chatId, text }) {
  if (!token || !chatId) {
    return { ok: false, error: 'Telegram token/chat id not configured.' };
  }
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url, { method: 'GET' });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error contacting Telegram.' };
  }
}

export function buildAlertMessage({ driverName, locationLink }) {
  const who = driverName ? driverName : 'Driver';
  const ts = new Date().toLocaleString();
  const loc = locationLink ? `\nLocation: ${locationLink}` : '\nLocation: unavailable';
  return `GoPal Alert: CRITICAL drowsiness detected for ${who}.\nTime: ${ts}${loc}`;
}

// ---- SMS deep link (manual-confirm) ----

/**
 * Builds an sms: URI. iOS/Android use different separators for prefilled body
 * ("&body=" vs "?body="); we default to "?" which both major mobile browsers accept
 * for a single recipient, and join multiple numbers with commas.
 */
export function buildSmsLink(numbers, body) {
  const nums = numbers.filter(Boolean).join(',');
  return `sms:${nums}?body=${encodeURIComponent(body)}`;
}
