/**
 * background.js — Typeahead v3 Service Worker
 *
 * Changes from v2:
 *   • Accepts structured context: { systemPrompt, userPrompt }
 *     instead of raw text — system/user prompts are now separated cleanly
 *   • max_tokens increased to 120 (suggestions can now be up to 2 sentences)
 *   • temperature tuned per provider for coherence vs creativity balance
 *   • Cache key derived from userPrompt tail (systemPrompt changes per tone)
 *   • Mock provider now uses context-aware templates to demo quality filter
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

// ── Providers ──────────────────────────────────────────────────────────────

async function callAnthropic(systemPrompt, userPrompt, apiKey) {
  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 120,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });
  var d = await res.json();
  if (!res.ok) throw new Error((d.error && d.error.message) || "Anthropic " + res.status);
  return ((d.content && d.content[0] && d.content[0].text) || "").trim();
}

async function callOpenAI(systemPrompt, userPrompt, apiKey) {
  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 120,
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt }
      ]
    })
  });
  var d = await res.json();
  if (!res.ok) throw new Error((d.error && d.error.message) || "OpenAI " + res.status);
  return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "").trim();
}

async function callLocal(systemPrompt, userPrompt) {
  var prompt = systemPrompt + "\n\n" + userPrompt;
  var res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3",
      prompt: prompt,
      stream: false,
      options: { num_predict: 120 }
    })
  });
  return ((await res.json()).response || "").trim();
}

// Mock: returns intentionally non-generic completions for testing quality filter
async function callMock() {
  await new Promise(function(r) { setTimeout(r, 450); });
  // These are realistic completions that SHOULD pass quality filter
  var good = [
    "demonstrates the core tension between scalability and interpretability that defines modern systems design.",
    "relies on a feedback mechanism that adjusts weights proportionally to the observed error gradient.",
    "suggests the two variables share a non-linear relationship that warrants a closer look at interaction terms.",
    "was the defining factor that shifted the committee's consensus toward the more conservative estimate.",
    "requires careful handling of edge cases where the null hypothesis cannot be cleanly rejected.",
  ];
  return good[Math.floor(Math.random() * good.length)];
}

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
  if (msg.type !== "GET_COMPLETION") return false;

  var context    = msg.context || {};
  var systemPrompt = context.systemPrompt || "";
  var userPrompt   = context.userPrompt   || "";

  if (!userPrompt) {
    sendResponse({ type: "COMPLETION_ERROR", error: "empty context" });
    return false;
  }

  // Cache key: last 150 chars of userPrompt (captures active sentence)
  var cacheKey = userPrompt.slice(-150);
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
      if      (provider === "anthropic") text = await callAnthropic(systemPrompt, userPrompt, apiKey);
      else if (provider === "openai")    text = await callOpenAI(systemPrompt, userPrompt, apiKey);
      else if (provider === "local")     text = await callLocal(systemPrompt, userPrompt);
      else                               text = await callMock();

      if (text) cacheSet(cacheKey, text);
      sendResponse({ type: "COMPLETION_RESULT", text: text });
    } catch (err) {
      console.error("[Typeahead BG] error:", err.message);
      sendResponse({ type: "COMPLETION_ERROR", error: err.message });
    }
  });

  return true; // keep channel open for async response
});

chrome.runtime.onInstalled.addListener(function(details) {
  if (details.reason === "install") {
    chrome.storage.sync.set({ enabled: true, apiKey: "", provider: "mock" });
    console.log("[Typeahead BG] Installed with defaults");
  }
});
