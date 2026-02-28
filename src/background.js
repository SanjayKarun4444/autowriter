/**
 * background.js — Typeahead v2 Service Worker
 *
 * Handles two-phase completion:
 *   Phase 1 — fast, concise (max_tokens: 60)
 *   Phase 2 — refined, higher quality (max_tokens: 100)
 *
 * Generation counter from content script is passed through for logging only.
 * Stale-response filtering happens in the content script.
 */

"use strict";

// ── LRU Cache ──────────────────────────────────────────────────────────────
var _cache = new Map();
var CACHE_MAX = 80;

function cacheGet(key) {
  if (!_cache.has(key)) return null;
  var v = _cache.get(key); _cache.delete(key); _cache.set(key, v); return v;
}
function cacheSet(key, val) {
  if (_cache.has(key)) _cache.delete(key);
  else if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(key, val);
}

// ── Prompts ────────────────────────────────────────────────────────────────

function getSystemPrompt(phase) {
  var base = "You are an AI writing assistant embedded in a text editor. " +
    "The user provides document context followed by the text to continue. " +
    "Match the author's exact tone, voice, and writing style precisely. " +
    "Return ONLY the continuation text — no quotes, no explanation, no prefix. ";

  if (phase === 1) {
    return base + "Be concise: continue in 1 sentence maximum.";
  }
  return base + "Continue naturally in 1–2 sentences. Prioritize coherence and style match.";
}

// ── Providers ──────────────────────────────────────────────────────────────

async function callAnthropic(prompt, apiKey, phase) {
  var maxTokens = phase === 1 ? 60 : 100;
  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: getSystemPrompt(phase),
      messages: [{ role: "user", content: prompt }]
    })
  });
  var d = await res.json();
  if (!res.ok) throw new Error(d.error && d.error.message || "Anthropic " + res.status);
  return ((d.content && d.content[0] && d.content[0].text) || "").trim();
}

async function callOpenAI(prompt, apiKey, phase) {
  var maxTokens = phase === 1 ? 60 : 100;
  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: maxTokens,
      temperature: phase === 1 ? 0.5 : 0.75,
      messages: [
        { role: "system", content: getSystemPrompt(phase) },
        { role: "user",   content: prompt }
      ]
    })
  });
  var d = await res.json();
  if (!res.ok) throw new Error(d.error && d.error.message || "OpenAI " + res.status);
  return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "").trim();
}

async function callLocal(prompt, phase) {
  var res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3",
      prompt: getSystemPrompt(phase) + "\n\n" + prompt,
      stream: false,
      options: { num_predict: phase === 1 ? 60 : 100 }
    })
  });
  return ((await res.json()).response || "").trim();
}

var MOCK_PHRASES = [
  " This approach has proven effective across a wide range of real-world applications.",
  " The evidence strongly supports this conclusion and warrants further investigation.",
  " It is worth considering how this might affect the broader context of the discussion.",
  " Further analysis will likely reveal additional insights worth exploring in depth.",
  " This pattern appears consistently across similar cases and merits careful attention.",
  " The implications of this finding extend well beyond the immediate scope of the work.",
  " Understanding this dynamic is essential for making informed decisions going forward.",
];

async function callMock(phase) {
  await new Promise(function(r) { setTimeout(r, phase === 1 ? 400 : 900); });
  return MOCK_PHRASES[Math.floor(Math.random() * MOCK_PHRASES.length)];
}

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
  if (msg.type !== "GET_COMPLETION") return false;

  var context  = msg.context  || "";
  var phase    = msg.phase    || 1;
  var cacheKey = context.slice(-180) + "|p" + phase;

  // Cache hit
  var hit = cacheGet(cacheKey);
  if (hit) {
    sendResponse({ type: "COMPLETION_RESULT", text: hit });
    return false;
  }

  chrome.storage.sync.get(["enabled", "apiKey", "provider"], async function(prefs) {
    if (prefs.enabled === false) {
      sendResponse({ type: "COMPLETION_ERROR", error: "disabled" });
      return;
    }
    var provider = prefs.provider || "mock";
    var apiKey   = prefs.apiKey   || "";

    try {
      var text = "";
      if      (provider === "anthropic") text = await callAnthropic(context, apiKey, phase);
      else if (provider === "openai")    text = await callOpenAI(context, apiKey, phase);
      else if (provider === "local")     text = await callLocal(context, phase);
      else                               text = await callMock(phase);

      if (text) cacheSet(cacheKey, text);
      sendResponse({ type: "COMPLETION_RESULT", text: text });
    } catch (err) {
      console.error("[Typeahead BG] p" + phase + " error:", err.message);
      sendResponse({ type: "COMPLETION_ERROR", error: err.message });
    }
  });

  return true; // keep channel open
});

chrome.runtime.onInstalled.addListener(function(details) {
  if (details.reason === "install") {
    chrome.storage.sync.set({ enabled: true, apiKey: "", provider: "mock" });
    console.log("[Typeahead BG] Installed with defaults");
  }
});
// Add this to your background.js
self.addEventListener('activate', (event) => {
  event.waitUntil(self.registration.navigationPreload?.disable() ?? Promise.resolve());
});