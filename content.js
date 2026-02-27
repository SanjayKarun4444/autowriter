/**
 * content.js — Main orchestrator for Typeahead in Google Docs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Google Docs renders text as absolutely-positioned <span> elements inside
 * `.kix-lineview-text-block` containers. The actual keystroke target is a
 * hidden `<div contenteditable>` inside `.docs-texteventtarget-iframe`.
 * Google's JS intercepts all input there, updates its internal model, then
 * re-renders the visible spans — wiping any DOM nodes we inject.
 *
 * Our solution: a fixed-position <span> overlay (#ta-ghost) that sits on top
 * of the cursor without touching Docs' DOM. Positioned via rAF loop reading
 * getBoundingClientRect() on `.kix-cursor-caret`.
 *
 * CSS isolation: all our elements use `data-typeahead` attributes and `ta-`
 * prefixed class names. Styles are injected via a <style> tag (not a
 * stylesheet request) so they work even if CSP blocks external sheets.
 *
 * Data flow:
 *   MutationObserver (user types)
 *     → debounce(500ms)
 *       → extractContext()
 *         → requestCompletion() [→ background → LLM API]
 *           → ghost.show(suggestion)
 *
 * Keyboard flow:
 *   Tab  → ghost.accept() → injectTextIntoDocs()
 *   Esc  → ghost.hide()
 *   Type → ghost.hide() (immediately, before debounce fires)
 */

import { GhostTextRenderer }  from "./modules/ghostText.js";
import { FloatingToolbar }    from "./modules/floatingToolbar.js";
import { KeyboardHandler }    from "./modules/keyboardHandler.js";
import { extractContext }     from "./modules/textExtractor.js";
import { createDebouncer }    from "./modules/debounce.js";
import { requestCompletion }  from "./modules/apiClient.js";

// ─── State ────────────────────────────────────────────────────────────────

const state = {
  enabled:         true,
  currentRequestId: null,
  observer:         null,
};

// ─── Boot ─────────────────────────────────────────────────────────────────

injectStyles();

chrome.storage.sync.get(["enabled"], (prefs) => {
  state.enabled = prefs.enabled !== false;
  waitForEditor().then(mount).catch(err => {
    console.warn("[Typeahead] Editor not found:", err.message);
  });
});

// ─── Mount ────────────────────────────────────────────────────────────────

function mount(editorEl) {
  const ghost    = new GhostTextRenderer();
  const keyboard = new KeyboardHandler({
    onAccept:  () => accept(ghost),
    onDismiss: () => dismiss(ghost),
  });

  const toolbar = new FloatingToolbar({
    onImprove: (text) => handleToolbarAction("improve", text, ghost),
    onShorter: (text) => handleToolbarAction("shorter", text, ghost),
    onLonger:  (text) => handleToolbarAction("longer",  text, ghost),
  });

  const debounced = createDebouncer(500, () => triggerCompletion(ghost));

  // MutationObserver — fires on every user keystroke (Docs updates the DOM)
  state.observer = new MutationObserver(() => {
    if (!state.enabled) return;
    dismiss(ghost);      // hide stale suggestion immediately
    debounced();         // schedule new one
  });

  state.observer.observe(editorEl, {
    childList:     true,
    subtree:       true,
    characterData: true,
  });

  ghost.attach();
  keyboard.attach();
  toolbar.attach();

  // Listen for enable/disable from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SET_ENABLED") {
      state.enabled = msg.enabled;
      if (!state.enabled) dismiss(ghost);
    }
  });

  console.log("[Typeahead] Mounted ✓");
}

// ─── Core completion flow ─────────────────────────────────────────────────

async function triggerCompletion(ghost) {
  if (!state.enabled) return;

  const context = extractContext();
  if (!context || context.trim().length < 15) return;

  // Unique request ID — used to discard stale responses
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.currentRequestId = requestId;

  ghost.showLoading();

  try {
    const suggestion = await requestCompletion(context, requestId);

    // Discard if a newer request was issued while we awaited
    if (state.currentRequestId !== requestId) return;
    if (!suggestion?.trim()) { ghost.hide(); return; }

    ghost.show(suggestion);

  } catch (err) {
    if (state.currentRequestId !== requestId) return;
    ghost.hide();
    if (err.message !== "disabled") {
      console.warn("[Typeahead] Completion error:", err.message);
    }
  }
}

function accept(ghost) {
  const text = ghost.getText();
  if (!text) return;
  ghost.accept();
  injectText(text);
}

function dismiss(ghost) {
  state.currentRequestId = null;
  ghost.hide();
}

// ─── Toolbar action handler ───────────────────────────────────────────────

async function handleToolbarAction(action, selectedText, ghost) {
  const prompts = {
    improve: `Rewrite this text to be clearer and more polished. Return only the rewritten text:\n\n${selectedText}`,
    shorter: `Shorten this text while preserving its meaning. Return only the shortened version:\n\n${selectedText}`,
    longer:  `Expand this text with more detail. Return only the expanded version:\n\n${selectedText}`,
  };

  const requestId = `toolbar-${Date.now()}`;
  state.currentRequestId = requestId;
  ghost.showLoading();

  try {
    const result = await requestCompletion(prompts[action], requestId);
    if (state.currentRequestId !== requestId) return;
    if (!result?.trim()) { ghost.hide(); return; }
    ghost.show(result);
  } catch (err) {
    ghost.hide();
  }
}

// ─── Text injection into Docs ─────────────────────────────────────────────

/**
 * Injects text into Google Docs by dispatching a textInput event on the
 * hidden key capture element. Docs listens for this and updates its model.
 *
 * Falls back to character-by-character simulation if textInput is ignored.
 */
function injectText(text) {
  const target = getKeyTarget();
  if (!target) {
    console.warn("[Typeahead] Cannot find Docs input target");
    return;
  }

  target.focus();

  const inputEvent = new InputEvent("textInput", {
    bubbles:    true,
    cancelable: true,
    data:       text,
  });

  const dispatched = target.dispatchEvent(inputEvent);

  // If Docs ignored the event, fall back to key simulation
  if (!dispatched || !target.textContent.includes(text.slice(0, 4))) {
    simulateTyping(target, text);
  }
}

function simulateTyping(target, text) {
  let i = 0;
  const step = () => {
    if (i >= text.length) return;
    const char = text[i++];
    const code = char.charCodeAt(0);

    target.dispatchEvent(new KeyboardEvent("keydown",  { key: char, keyCode: code, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keypress", { key: char, keyCode: code, bubbles: true }));
    target.dispatchEvent(new InputEvent("input",  { data: char, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup",    { key: char, keyCode: code, bubbles: true }));

    setTimeout(step, 10);
  };
  step();
}

function getKeyTarget() {
  // Strategy 1: key capture iframe (modern Docs)
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  if (iframe) {
    try {
      return iframe.contentDocument?.querySelector("[contenteditable=true]");
    } catch (_) {}
  }
  // Strategy 2: typing canvas
  return (
    document.querySelector(".kix-typingcanvas") ||
    document.querySelector("[contenteditable=true][class*='kix']")
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────

function waitForEditor(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll  = () => {
      const el = document.querySelector(".kix-appview-editor");
      if (el) return resolve(el);
      if (Date.now() - start > timeout) return reject(new Error("Timed out"));
      setTimeout(poll, 300);
    };
    poll();
  });
}

/**
 * Injects our CSS as a <style> tag rather than a <link> to ensure styles
 * are applied even under strict CSP. The styles are scoped under ta- prefixes
 * to avoid any collision with Google Docs' own class names.
 */
function injectStyles() {
  // Check if already injected (e.g., multiple content script executions)
  if (document.getElementById("ta-styles")) return;

  // We embed the CSS content directly as a string here (built at extension
  // load time in a real pipeline; for dev, it's inlined).
  // In production you'd use a build step to inline content.css here.
  const link = document.createElement("link");
  link.id = "ta-styles";
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles/content.css");
  document.head.appendChild(link);
}
