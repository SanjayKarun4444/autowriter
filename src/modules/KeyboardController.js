/**
 * KeyboardController.js — Reliable Tab/Esc interception for Google Docs
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE PREVIOUS IMPLEMENTATION FAILED
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Google Docs architecture:
 *   The visible document is rendered in the main frame, but ALL keyboard
 *   input is captured by a hidden <iframe class="docs-texteventtarget-iframe">.
 *   This iframe contains a single <div contenteditable="true">.
 *
 *   When the user presses Tab:
 *     1. keydown fires inside the iframe's document
 *     2. Docs' JS inside the iframe calls preventDefault() and handles Tab
 *        (e.g., adds indent or moves focus)
 *     3. The event does NOT bubble to the parent document
 *
 *   The old code attached to `document` (parent frame). It never saw the
 *   Tab event because cross-frame bubbling does not occur for keyboard events.
 *   event.preventDefault() called in the parent frame had no effect on an
 *   event that originated inside a different frame.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE FIX
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   1. Locate the iframe's contentDocument
 *   2. Attach the keydown listener directly to the iframe's document
 *      (not the parent document) in capture phase
 *   3. Use stopImmediatePropagation() to prevent Docs' own listener from
 *      running (Docs also uses capture listeners — immediate propagation
 *      stop is needed, not just stopPropagation)
 *
 *   Because content scripts run in an "isolated world", we can access
 *   iframe.contentDocument if the iframe is same-origin with the parent.
 *   Google Docs' key capture iframe IS same-origin (both docs.google.com),
 *   so this works reliably.
 *
 *   We also attach to the PARENT document as a fallback in case Docs
 *   changes its architecture (e.g., future versions may not use an iframe).
 *
 *   MutationObserver on the iframe slot ensures we reattach if Docs
 *   recreates the iframe (which can happen on document reload within SPA).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ESC HANDLING
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   Esc is simpler — Docs doesn't intercept it aggressively in the same
 *   way. We attach in both frames for safety.
 */

export class KeyboardController {

  constructor({ onAccept, onDismiss, isSuggestionVisible }) {
    this._onAccept           = onAccept;
    this._onDismiss          = onDismiss;
    this._isSuggestionVisible = isSuggestionVisible;

    this._handler            = this._handle.bind(this);
    this._attachedDocs       = new Set(); // track which documents have listener
    this._iframeObserver     = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  attach() {
    // 1. Always attach to parent document (fallback + Esc safety)
    this._addTo(document);

    // 2. Attach to the Docs input iframe if present
    this._attachToInputIframe();

    // 3. Watch for the iframe being added/replaced (Docs SPA navigation)
    this._iframeObserver = new MutationObserver(() => {
      this._attachToInputIframe();
    });
    this._iframeObserver.observe(document.body, { childList: true, subtree: true });
  }

  detach() {
    for (const doc of this._attachedDocs) {
      doc.removeEventListener("keydown", this._handler, { capture: true });
    }
    this._attachedDocs.clear();
    this._iframeObserver?.disconnect();
    this._iframeObserver = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _attachToInputIframe() {
    const iframe = document.querySelector(".docs-texteventtarget-iframe");
    if (!iframe) return;

    let iframeDoc;
    try {
      iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
    } catch (_) {
      // Cross-origin — shouldn't happen for Docs but guard anyway
      console.warn("[Typeahead] Cannot access key capture iframe — cross-origin");
      return;
    }

    if (iframeDoc && !this._attachedDocs.has(iframeDoc)) {
      this._addTo(iframeDoc);
    }
  }

  _addTo(doc) {
    if (this._attachedDocs.has(doc)) return;
    doc.addEventListener("keydown", this._handler, { capture: true });
    this._attachedDocs.add(doc);
  }

  _handle(event) {
    if (!this._isSuggestionVisible()) return;

    if (event.key === "Tab") {
      // Both prevent Docs from seeing Tab AND stop other capture listeners
      event.preventDefault();
      event.stopImmediatePropagation();
      this._onAccept();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this._onDismiss();
      return;
    }

    // Any printable character typed → dismiss suggestion immediately
    // This prevents ghost text lingering while user keeps typing
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      this._onDismiss();
      // Do NOT preventDefault here — let the keystroke through to Docs
    }
  }
}
