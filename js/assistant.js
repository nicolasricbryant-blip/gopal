// assistant.js — conversation manager: STT, TTS, LLM adapters, scripted fallback.
// Hybrid brain: cloud LLM when online + API key configured, otherwise a scripted
// dialogue bank keeps the co-pilot fully functional offline (parity with the
// original VC-02 offline claim).

const SYSTEM_PROMPT =
  'You are GoPal, a friendly co-pilot keeping a drowsy driver alert and engaged. ' +
  'Reply in at most 2 short sentences. Ask an engaging question to keep them talking. ' +
  'Never tell the driver to close their eyes or rest while driving. ' +
  'If the driver seems unresponsive or their replies are incoherent, urge them to pull over safely and rest.';

const LLM_TIMEOUT_MS = 4000;

// ---- Scripted fallback dialogue bank (~20 entries) ----
// Each entry: opening line + optional keyword-matched follow-ups.
const SCRIPTED_BANK = [
  { open: "Hey, still with me? What's the first thing you're going to do when you arrive?", keywords: { home: 'Nice, sounds relaxing. How far out are you now?', work: 'Got it. Anything big on your plate today?', eat: "Good call, food helps. What's the plan?" }, fallback: "Tell me more — I'm listening." },
  { open: "Quick one: what's 7 plus 15?", keywords: { '22': "That's right! Sharp as ever.", default: "Close enough — keep that brain warm. Try 9 plus 8 next time." }, fallback: 'Good try — keep talking to me.' },
  { open: 'Tell me about your destination — what makes it worth the drive?', keywords: {}, fallback: 'Sounds good, keep going, I want to hear more.' },
  { open: "Let's do a quick stretch — roll your shoulders back twice, keeping your eyes on the road. Done?", keywords: { yes: 'Nice work. Feeling any more awake?', done: 'Nice work. Feeling any more awake?' }, fallback: 'No rush, whenever you can.' },
  { open: "What's your favorite song to blast on a long drive?", keywords: {}, fallback: 'Good taste. Want to sing a line of it for me?' },
  { open: 'Trivia time: what planet is known as the Red Planet?', keywords: { mars: "Correct! You're on it.", default: "It's Mars — got it? Let's try another later." }, fallback: 'Take your time, no wrong answers here.' },
  { open: 'How long have you been driving today?', keywords: {}, fallback: "Got it. Let's keep the conversation going a bit longer." },
  { open: "Name three things you can see right now, out loud.", keywords: {}, fallback: 'Good, that helps keep your focus sharp.' },
  { open: 'Quick math: what is 12 minus 4?', keywords: { '8': 'Correct, nice and quick.', default: "It's 8 — no worries, let's keep chatting." }, fallback: 'Keep thinking, take your time.' },
  { open: "What's the last movie or show you watched?", keywords: {}, fallback: 'Sounds interesting, tell me why you liked it.' },
  { open: 'If you could pull over right now for a 5 minute break, would you take it?', keywords: { yes: "That's the safest call — find a safe spot when you can.", no: 'Okay, but keep that option in mind if you start feeling worse.' }, fallback: 'Worth thinking about — your safety comes first.' },
  { open: 'Tell me about someone you are looking forward to seeing today.', keywords: {}, fallback: "That's nice. How long has it been since you last saw them?" },
  { open: "What's the weather like where you are right now?", keywords: {}, fallback: 'Good to know. Drive safe out there.' },
  { open: 'Quick trivia: how many continents are there?', keywords: { '7': "That's right, seven continents!", seven: "That's right, seven continents!", default: "It's seven — how about that." }, fallback: 'Take a guess, no pressure.' },
  { open: 'Give me a countdown from ten out loud, nice and clear.', keywords: {}, fallback: 'Good, that helps wake the brain up.' },
  { open: "What's a good meal you're craving right now?", keywords: {}, fallback: 'Sounds delicious. Where would you get that?' },
  { open: 'Roll down the window a crack for some fresh air — can you do that safely right now?', keywords: { yes: 'Great, that airflow should help.', no: "That's fine, we'll try something else." }, fallback: 'Only if it is safe to do so right now.' },
  { open: 'Tell me your favorite road trip memory.', keywords: {}, fallback: 'Love that. What made it memorable?' },
  { open: 'Quick check — say your name and where you are headed.', keywords: {}, fallback: "Got it, thanks for staying with me." },
  { open: "What's one thing you're grateful for today?", keywords: {}, fallback: "That's a good one to hold onto." },
];

function pickScriptedEntry(excludeIndex) {
  let idx;
  do {
    idx = Math.floor(Math.random() * SCRIPTED_BANK.length);
  } while (SCRIPTED_BANK.length > 1 && idx === excludeIndex);
  return { idx, entry: SCRIPTED_BANK[idx] };
}

function matchKeyword(entry, reply) {
  if (!reply) return entry.fallback;
  const lower = reply.toLowerCase();
  for (const [kw, line] of Object.entries(entry.keywords || {})) {
    if (kw === 'default') continue;
    if (lower.includes(kw)) return line;
  }
  return entry.keywords?.default || entry.fallback;
}

// ---- Speech-to-text ----

export class SpeechListener {
  constructor(lang = 'en-US') {
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!Impl;
    this.Impl = Impl;
    this.lang = lang;
    this.recognition = null;
  }

  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** Listens for a single utterance, resolves with transcript or '' on silence/timeout. */
  listenOnce(timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!this.supported) {
        resolve('');
        return;
      }
      const rec = new this.Impl();
      this.recognition = rec;
      rec.lang = this.lang;
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      let done = false;
      const finish = (text) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { rec.stop(); } catch { /* already stopped */ }
        resolve(text);
      };

      const timer = setTimeout(() => finish(''), timeoutMs);

      rec.onresult = (event) => {
        const text = event.results?.[0]?.[0]?.transcript || '';
        finish(text);
      };
      rec.onerror = () => finish('');
      rec.onend = () => finish('');

      try {
        rec.start();
      } catch {
        finish('');
      }
    });
  }

  abort() {
    try { this.recognition?.abort(); } catch { /* noop */ }
  }
}

// ---- Text-to-speech ----

export class SpeechSpeaker {
  constructor(rate = 1.0) {
    this.rate = rate;
    this.supported = 'speechSynthesis' in window;
  }

  static isSupported() {
    return 'speechSynthesis' in window;
  }

  _pickVoice(lang) {
    const voices = window.speechSynthesis.getVoices();
    return voices.find((v) => v.lang === lang) || voices.find((v) => v.lang?.startsWith(lang.split('-')[0])) || voices[0];
  }

  /**
   * Cancels any queued speech (used on new CRITICAL events) then speaks `text`.
   * `onStart` fires the moment audio actually begins — used for latency metrics.
   */
  speak(text, lang = 'en-US', onStart) {
    return new Promise((resolve) => {
      if (!this.supported) {
        onStart?.();
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = this.rate;
      utter.lang = lang;
      const voice = this._pickVoice(lang);
      if (voice) utter.voice = voice;
      utter.onstart = () => onStart?.();
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    });
  }

  cancel() {
    if (this.supported) window.speechSynthesis.cancel();
  }
}

// ---- LLM adapters ----

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('LLM request timed out')), ms)),
  ]);
}

async function callGemini(apiKey, history, userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const contents = [
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: userText }] },
  ];
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { maxOutputTokens: 100, temperature: 0.8 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text.');
  return text.trim();
}

async function callClaude(apiKey, history, userText) {
  const url = 'https://api.anthropic.com/v1/messages';
  const messages = [
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })),
    { role: 'user', content: userText },
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('Claude returned no text.');
  return text.trim();
}

// ---- Conversation manager ----

export class Assistant {
  /** @param {{ provider: string, geminiKey: string, claudeKey: string, lang: string, ttsRate: number }} config */
  constructor(config) {
    this.config = config;
    this.speaker = new SpeechSpeaker(config.ttsRate);
    this.listener = new SpeechListener(config.lang);
    this.history = [];
    this._lastScriptedIdx = null;
  }

  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this.speaker.rate = this.config.ttsRate;
    this.listener.lang = this.config.lang;
  }

  /**
   * Runs one check-in turn: speak an opening line, listen for a reply, and
   * return { spoken, heard, source } where source is 'llm' | 'scripted'.
   *
   * Latency hooks (all optional, used by metrics.js to mirror the paper's tests):
   *   hooks.onFirstWord()  — assistant's opening line audio starts
   *   hooks.onReplyHeard() — driver's utterance finished (STT resolved non-empty)
   *   hooks.onReplyStart() — assistant's follow-up reply audio starts
   */
  async runTurn(openingOverride, hooks = {}) {
    const useLlm = this.config.provider === 'gemini' || this.config.provider === 'claude';
    let spoken;
    let source = 'scripted';
    let scriptedCtx = null;

    if (openingOverride) {
      spoken = openingOverride;
    } else if (useLlm && navigator.onLine) {
      try {
        const key = this.config.provider === 'gemini' ? this.config.geminiKey : this.config.claudeKey;
        if (!key) throw new Error('No API key configured.');
        const caller = this.config.provider === 'gemini' ? callGemini : callClaude;
        spoken = await withTimeout(caller(key, this.history, 'Check in with the driver now.'), LLM_TIMEOUT_MS);
        source = 'llm';
      } catch (err) {
        console.warn('[assistant] LLM call failed, using scripted fallback', err.message);
        const { idx, entry } = pickScriptedEntry(this._lastScriptedIdx);
        this._lastScriptedIdx = idx;
        scriptedCtx = entry;
        spoken = entry.open;
      }
    } else {
      const { idx, entry } = pickScriptedEntry(this._lastScriptedIdx);
      this._lastScriptedIdx = idx;
      scriptedCtx = entry;
      spoken = entry.open;
    }

    this.history.push({ role: 'assistant', text: spoken });
    await this.speaker.speak(spoken, this.config.lang, hooks.onFirstWord);

    const heard = await this.listener.listenOnce(8000);
    if (heard) {
      this.history.push({ role: 'user', text: heard });
      hooks.onReplyHeard?.();
    }

    let reply = null;
    if (heard && source === 'scripted' && scriptedCtx) {
      reply = matchKeyword(scriptedCtx, heard);
    } else if (heard && source === 'llm' && this.config.provider && navigator.onLine) {
      try {
        const key = this.config.provider === 'gemini' ? this.config.geminiKey : this.config.claudeKey;
        const caller = this.config.provider === 'gemini' ? callGemini : callClaude;
        reply = await withTimeout(caller(key, this.history, heard), LLM_TIMEOUT_MS);
      } catch (err) {
        console.warn('[assistant] LLM follow-up failed', err.message);
        reply = "Thanks for the reply — stay with me.";
      }
    }

    if (reply) {
      this.history.push({ role: 'assistant', text: reply });
      await this.speaker.speak(reply, this.config.lang, hooks.onReplyStart);
    }

    // Cap history length to keep payloads small.
    if (this.history.length > 12) this.history = this.history.slice(-12);

    return { spoken, heard, reply, source };
  }

  interrupt() {
    this.speaker.cancel();
    this.listener.abort();
  }

  resetHistory() {
    this.history = [];
  }
}
