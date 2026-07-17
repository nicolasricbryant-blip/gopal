// storage.test.js — localStorage persistence layer, exercised against an
// in-memory stub since storage.js probes `localStorage` at module load time.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

let storage;

beforeAll(async () => {
  globalThis.localStorage = createMemoryStorage();
  storage = await import('../js/storage.js');
});

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    const s = storage.getSettings();
    expect(s.earThreshold).toBe(0.21);
    expect(s.calibrated).toBe(false);
    expect(s.sttLang).toBe('en-US');
    expect(s.ttsRate).toBe(1.0);
    expect(s.volume).toBe(0.8);
    expect(s.llmProvider).toBe('none');
    expect(s.wakeLock).toBe(true);
    expect(s.reducedMotion).toBe(false);
  });

  it('saveSettings merges into existing settings rather than replacing them', () => {
    storage.saveSettings({ driverName: 'Mark', ttsRate: 1.2 });
    const s = storage.getSettings();
    expect(s.driverName).toBe('Mark');
    expect(s.ttsRate).toBe(1.2);
    expect(s.earThreshold).toBe(0.21); // untouched default survives the merge
  });

  it('falls back to defaults when the stored JSON is corrupted', () => {
    globalThis.localStorage.setItem('gopal_settings_v1', '{not valid json');
    const s = storage.getSettings();
    expect(s.earThreshold).toBe(0.21);
    expect(s.calibrated).toBe(false);
  });
});

describe('contacts', () => {
  it('addContact then removeContact round-trips', () => {
    expect(storage.getContacts()).toEqual([]);
    storage.addContact({ name: 'Ana', phone: '+1 555 0100' });
    const contacts = storage.getContacts();
    expect(contacts.length).toBe(1);
    expect(contacts[0].name).toBe('Ana');
    expect(contacts[0].id).toBeTruthy();

    storage.removeContact(contacts[0].id);
    expect(storage.getContacts()).toEqual([]);
  });
});

describe('sessions', () => {
  it('caps stored history at 50, newest first', () => {
    for (let i = 0; i < 55; i++) {
      storage.saveSession({ id: `s_${i}` });
    }
    const sessions = storage.getSessions();
    expect(sessions.length).toBe(50);
    expect(sessions[0].id).toBe('s_54'); // most recently saved is unshifted to the front
    expect(sessions[sessions.length - 1].id).toBe('s_5'); // oldest 5 were evicted
  });
});
