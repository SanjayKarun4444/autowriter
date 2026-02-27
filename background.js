/**
 * background.js — Manifest V3 Service Worker
 *
 * Sole responsibility: relay LLM requests from content scripts.
 * All network calls happen here (avoids CORS, keeps API keys out of
 * the page context). Includes simple LRU cache and pluggable provider system.
 *
 * Provider system: change PROVIDER constant or make it dynamic via storage.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// LRU Cache
// ═══════════════════════════════════════════════════════════════════════════

class LRUCache {
  constructor(maxSize = 60) {
    this._map  = new Map();
    this._max  = maxSize;
  }
  get(key) {
    if (!this._map.has(key)) return null;
    // Re-insert to refresh recency
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this._max) {
      // Evict oldest
      this._map.delete(this._map.keys().next().value);
    }
    this._map.set(key, value);
  }
}

const cache = new LRUCache(60);

// ═══════════════════════════════════════════════════════════════════════════
// LLM Providers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All providers receive (context: string, apiKey: string) and return
 * a Promise<string> of the continuation text.
 */
const PROVIDERS = {

  // ── Anthropic ────────────────────────────────────────────────────────────
  async anthropic(context, apiKey) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-api-key":       apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 80,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: "user", content: context }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Anthropic ${res.status}`);
    return (data.content?.[0]?.text || "").trim();
  },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  async openai(context, apiKey) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       "gpt-4o-mini",
        max_tokens:  80,
        temperature: 0.7,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: context },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `OpenAI ${res.status}`);
    return (data.choices?.[0]?.message?.content || "").trim();
  },

  // ── Local LLM (Ollama / LM Studio) ───────────────────────────────────────
  async local(context, _apiKey) {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model:   "llama3",
        prompt:  `${SYSTEM_PROMPT}\n\n${context}`,
        stream:  false,
        options: { num_predict: 80 },
      }),
    });
    const data = await res.json();
    return (data.response || "").trim();
  },

  // ── Mock / Demo ───────────────────────────────────────────────────────────
  async mock(_context, _apiKey) {
    await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
    const demos = [
      " This approach has proven effective across a wide range of applications.",
      " The data clearly supports this conclusion, with results consistent across all trials.",
      " Further investigation will likely reveal additional nuances worth exploring.",
      " It is important to consider these factors when making any final decision.",
      " The evidence suggests this trend will continue throughout the coming year.",
    ];
    return demos[Math.floor(Math.random() * demos.length)];
  },
};

const SYSTEM_PROMPT =
  "You are a writing assistant embedded in a text editor. " +
  "Continue the text naturally in 1–2 sentences. " +
  "Match the author's exact tone, voice, and style. " +
  "Return ONLY the continuation — no quotes, no explanation, no prefix. " +
  "If the text ends mid-sentence, complete that sentence first.";

// ═══════════════════════════════════════════════════════════════════════════
// Message handler
// ═══════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_COMPLETION") return false;

  const { context, requestId } = message;
  const cacheKey = context.slice(-140);

  // Cache hit — synchronous return
  const cached = cache.get(cacheKey);
  if (cached) {
    sendResponse({ type: "COMPLETION_RESULT", text: cached, requestId });
    return false;
  }

  // Async path
  chrome.storage.sync.get(["enabled", "apiKey", "provider"], async (prefs) => {
    if (prefs.enabled === false) {
      sendResponse({ type: "COMPLETION_ERROR", error: "disabled", requestId });
      return;
    }

    const provider = prefs.provider || "mock";
    const apiKey   = prefs.apiKey   || "";
    const fn       = PROVIDERS[provider] ?? PROVIDERS.mock;

    try {
      const text = await fn(context, apiKey);
      cache.set(cacheKey, text);
      sendResponse({ type: "COMPLETION_RESULT", text, requestId });
    } catch (err) {
      console.error(`[Typeahead] ${provider} error:`, err.message);
      sendResponse({ type: "COMPLETION_ERROR", error: err.message, requestId });
    }
  });

  return true; // keep message channel open for async sendResponse
});

// ═══════════════════════════════════════════════════════════════════════════
// Install / update
// ═══════════════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.storage.sync.set({
      enabled:  true,
      apiKey:   "",
      provider: "mock",
    });
  }
});
