// assistant-history.test.js — buildProviderHistory sanitizes conversation
// history so it satisfies the Claude/Gemini "first message must be user, no
// adjacent same-role turns" requirement.

import { describe, it, expect } from 'vitest';
import { buildProviderHistory } from '../js/assistant.js';

describe('buildProviderHistory', () => {
  it('drops leading assistant messages until the first user message', () => {
    const history = [
      { role: 'assistant', text: 'Hi' },
      { role: 'assistant', text: 'Still there?' },
      { role: 'user', text: 'Yeah' },
      { role: 'assistant', text: 'Great' },
    ];
    expect(buildProviderHistory(history)).toEqual([
      { role: 'user', text: 'Yeah' },
      { role: 'assistant', text: 'Great' },
    ]);
  });

  it('merges consecutive same-role messages by joining text with a newline', () => {
    const history = [
      { role: 'user', text: 'Hello' },
      { role: 'user', text: 'Anyone there?' },
      { role: 'assistant', text: 'Yes' },
      { role: 'assistant', text: 'Go ahead' },
    ];
    expect(buildProviderHistory(history)).toEqual([
      { role: 'user', text: 'Hello\nAnyone there?' },
      { role: 'assistant', text: 'Yes\nGo ahead' },
    ]);
  });

  it('collapses an all-assistant history to an empty array', () => {
    const history = [
      { role: 'assistant', text: 'Hi' },
      { role: 'assistant', text: 'Hello?' },
    ];
    expect(buildProviderHistory(history)).toEqual([]);
  });

  it('leaves an already-alternating history unchanged', () => {
    const history = [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
      { role: 'user', text: 'Bye' },
    ];
    expect(buildProviderHistory(history)).toEqual(history);
  });

  it('returns an empty array for an empty history', () => {
    expect(buildProviderHistory([])).toEqual([]);
  });
});
