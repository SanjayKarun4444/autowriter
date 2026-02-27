/**
 * content.js — Typeahead v3 Orchestrator
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Module responsibilities:
 *
 *   ContextManager      — Reads Google Docs DOM; extracts activeSentence,
 *                          recentParagraphs, documentSummary, detectedTone
 *
 *   PromptEngine        — Builds system + user prompts from context.
 *                          Tone-specific guidance, banned phrases, format rules.
 *
 *   QualityFilter       — Validates API response before display.
 *                          Rejects generic, repetitive, or too-short suggestions.
 *
 *   SuggestionController — Orchestrates: debounce → context → prompt → API →
 *                          quality check → retry → render/suppress.
 *                          Uses generation counter for stale-response safety.
 *
 *   GhostRenderer       — Fixed-position overlay; rAF position loop;
 *                          loading/visible/accepting states; undo handling.
 *
 *   KeyboardController  — Attaches to BOTH parent document AND the Docs
 *                          key-capture iframe's contentDocument.
 *                          capture:true + stopImmediatePropagation ensures
 *                          Tab/Esc are intercepted before Docs sees them.
 *
 *   FloatingToolbar     — Selection-triggered improve/shorter/longer actions.
 *
 * Data flow:
 *   MutationObserver (user types in Docs DOM)
 *     → SuggestionController debounce (500ms)
 *       → ContextManager.extract()
 *         → PromptEngine.build*()
 *           → background.js → LLM API
 *             → QualityFilter.validate()
 *               → GhostRenderer.show() | retry | hide()
 *
 * Keyboard flow:
 *   Tab  → KeyboardController → accept() → injectTextIntoDocs()
 *   Esc  → KeyboardController → dismiss()
 *   Char → KeyboardController → dismiss() immediately (no wait for debounce)
 */

import { GhostRenderer       } from "./modules/GhostRenderer.js";
import { KeyboardController  } from "./modules/KeyboardController.js";
import { SuggestionController} from "./modules/SuggestionController.js";
import { FloatingToolbar     } from "./modules/floatingToolbar.js";
import { requestCompletion   } from "./modules/apiClient.js";

// ─── Boot ─────────────────────────────────────────────────────────────────

injectStyles();

chrome.storage.sync.get(["enabled"], (prefs) => {
  const enabled = prefs.enabled !== false;
  waitForEditor()
    .then(el => mount(el, enabled))
    .catch(err => console.warn("[Typeahead] Editor not found:", err.message));
});

// ─── Mount ────────────────────────────────────────────────────────────────

function mount(editorEl, initiallyEnabled) {
  const ghost      = new GhostRenderer();
  const controller = new SuggestionController({ ghost, apiClient: { requestCompletion } });

  const keyboard = new KeyboardController({
    onAccept:           () => accept(ghost, controller),
    onDismiss:          () => controller.dismiss(),
    isSuggestionVisible: () => ghost.isVisible(),
  });

  const toolbar = new FloatingToolbar({
    onImprove: (text) => handleToolbarAction("improve", text, ghost),
    onShorter: (text) => handleToolbarAction("shorter", text, ghost),
    onLonger:  (text) => handleToolbarAction("longer",  text, ghost),
  });

  ghost.attach();
  keyboard.attach();
  toolbar.attach();

  if (initiallyEnabled) {
    controller.start(editorEl);
  }

  // Toggle from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SET_ENABLED") {
      if (msg.enabled) {
        controller.start(editorEl);
      } else {
        controller.stop();
      }
    }
  });

  console.log("[Typeahead] Mounted v3 ✓");
}

// ─── Accept ───────────────────────────────────────────────────────────────

function accept(ghost, controller) {
  const text = ghost.getText();
  if (!text) return;
  ghost.accept();
  controller.dismiss(); // cancel debounce so acceptance doesn't trigger new suggestion
  injectText(text);
}

// ─── Toolbar action ───────────────────────────────────────────────────────

async function handleToolbarAction(action, selectedText, ghost) {
  const prompts = {
    improve: `Rewrite this text to be clearer and more polished. Return only the rewritten text, no explanation:\n\n${selectedText}`,
    shorter: `Shorten this text while preserving its meaning. Return only the result:\n\n${selectedText}`,
    longer:  `Expand this text with more relevant detail. Return only the result:\n\n${selectedText}`,
  };

  ghost.showLoading();
  try {
    const result = await requestCompletion({
      systemPrompt: "You are a professional editor. Follow the instruction exactly. Return only the edited text.",
      userPrompt: prompts[action],
    });
    if (result?.trim()) ghost.show(result);
    else ghost.hide();
  } catch (_) {
    ghost.hide();
  }
}

// ─── Text injection into Docs ─────────────────────────────────────────────

/**
 * Inject text into Google Docs.
 *
 * Strategy 1 — execCommand('insertText'):
 *   The most reliable modern approach. Works when the Docs contenteditable
 *   element is focused. Preserves undo stack (single undo step for the
 *   entire insertion). Does NOT work in readonly mode.
 *
 * Strategy 2 — textInput event:
 *   Older fallback. Works if execCommand is disabled.
 *
 * Strategy 3 — character-by-character simulation:
 *   Last resort. Slow but works across all Docs versions.
 *   Each char goes through Docs' full event processing pipeline.
 */
function injectText(text) {
  const target = getKeyTarget();
  if (!target) {
    console.warn("[Typeahead] Cannot find Docs input target");
    return;
  }

  target.focus();

  // Strategy 1: execCommand
  if (document.execCommand) {
    try {
      // execCommand must run in the iframe context if target is inside iframe
      const ownerDoc = target.ownerDocument || document;
      ownerDoc.execCommand("insertText", false, text);

      // Verify it worked by checking if Docs re-rendered
      // (Docs' MutationObserver will fire and the rendered DOM will update)
      return;
    } catch (_) {}
  }

  // Strategy 2: textInput event
  const inputEvent = new InputEvent("textInput", {
    bubbles:    true,
    cancelable: true,
    data:       text,
  });
  const handled = target.dispatchEvent(inputEvent);
  if (handled) return;

  // Strategy 3: character simulation
  simulateTyping(target, text);
}

function simulateTyping(target, text) {
  let i = 0;
  const step = () => {
    if (i >= text.length) return;
    const char = text[i++];
    const code = char.charCodeAt(0);
    target.dispatchEvent(new KeyboardEvent("keydown",  { key: char, keyCode: code, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keypress", { key: char, keyCode: code, bubbles: true, cancelable: true }));
    target.dispatchEvent(new InputEvent("input", { data: char, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup",    { key: char, keyCode: code, bubbles: true, cancelable: true }));
    setTimeout(step, 8);
  };
  step();
}

function getKeyTarget() {
  // Primary: Docs key capture iframe
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  if (iframe) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      const el = iframeDoc?.querySelector("[contenteditable=true]");
      if (el) return el;
    } catch (_) {}
  }
  // Fallbacks
  return (
    document.querySelector(".kix-typingcanvas") ||
    document.querySelector("[contenteditable=true][class*='kix']")
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────

function waitForEditor(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const el = document.querySelector(".kix-appview-editor");
      if (el) return resolve(el);
      if (Date.now() - start > timeout) return reject(new Error("Timed out"));
      setTimeout(poll, 300);
    };
    poll();
  });
}

function injectStyles() {
  if (document.getElementById("ta-styles")) return;
  const link = document.createElement("link");
  link.id  = "ta-styles";
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles/content.css");
  document.head.appendChild(link);
}
