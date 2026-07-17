// storage.js — localStorage persistence layer: settings, contacts, sessions, API keys.
// Everything lives client-side only. No data ever leaves the device except the
// explicit alert calls made from alerts.js (Telegram/SMS), which read keys from here.

const KEYS = {
  settings: 'gopal_settings_v1',
  contacts: 'gopal_contacts_v1',
  sessions: 'gopal_sessions_v1',
};

const DEFAULT_SETTINGS = {
  driverName: '',
  earThreshold: 0.21,          // calibrated at session start, this is the fallback default
  calibrated: false,
  sttLang: 'en-US',
  ttsRate: 1.0,
  volume: 0.8,
  llmProvider: 'none',         // 'none' | 'gemini' | 'claude'
  geminiKey: '',
  claudeKey: '',
  telegramToken: '',
  telegramChatId: '',
  reducedMotion: false,        // user override; auto-detected value is merged at read time
  wakeLock: true,
};

function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch (err) {
    console.warn('[storage] failed to parse JSON, using fallback', err);
    return fallback;
  }
}

function isStorageAvailable() {
  try {
    const testKey = '__gopal_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export const storageAvailable = isStorageAvailable();

// ---- Settings ----

export function getSettings() {
  if (!storageAvailable) return { ...DEFAULT_SETTINGS };
  const stored = safeParse(localStorage.getItem(KEYS.settings), {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(partial) {
  const current = getSettings();
  const next = { ...current, ...partial };
  if (storageAvailable) {
    localStorage.setItem(KEYS.settings, JSON.stringify(next));
  }
  return next;
}

// ---- Emergency contacts ----
// contact shape: { id, name, phone }

export function getContacts() {
  if (!storageAvailable) return [];
  return safeParse(localStorage.getItem(KEYS.contacts), []);
}

export function saveContacts(contacts) {
  if (storageAvailable) {
    localStorage.setItem(KEYS.contacts, JSON.stringify(contacts));
  }
  return contacts;
}

export function addContact(contact) {
  const contacts = getContacts();
  const withId = { id: contact.id || `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...contact };
  contacts.push(withId);
  saveContacts(contacts);
  return contacts;
}

export function removeContact(id) {
  const contacts = getContacts().filter((c) => c.id !== id);
  saveContacts(contacts);
  return contacts;
}

// ---- Session history ----
// session shape: { id, startedAt, endedAt, durationSec, perclosMax, blinkCount,
//   yawnCount, criticalCount, warningCount, events: [...], latencies: { alert:[], activation:[], turnTaking:[] } }

const MAX_STORED_SESSIONS = 50;

export function getSessions() {
  if (!storageAvailable) return [];
  return safeParse(localStorage.getItem(KEYS.sessions), []);
}

export function saveSession(session) {
  const sessions = getSessions();
  sessions.unshift(session);
  while (sessions.length > MAX_STORED_SESSIONS) sessions.pop();
  if (storageAvailable) {
    localStorage.setItem(KEYS.sessions, JSON.stringify(sessions));
  }
  return sessions;
}

export function clearSessions() {
  if (storageAvailable) {
    localStorage.removeItem(KEYS.sessions);
  }
  return [];
}
