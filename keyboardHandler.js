/**
 * keyboardHandler.js — Tab/Esc interception
 *
 * Attaches to `document` in capture phase so we get events before Docs.
 * Only handles Tab (accept) and Esc (dismiss) — all other keys pass through.
 */

export class KeyboardHandler {
  constructor({ onAccept, onDismiss }) {
    this._onAccept  = onAccept;
    this._onDismiss = onDismiss;
    this._handler   = this._handle.bind(this);
  }

  attach() {
    document.addEventListener("keydown", this._handler, { capture: true });
  }

  detach() {
    document.removeEventListener("keydown", this._handler, { capture: true });
  }

  _handle(event) {
    if (!this._isSuggestionVisible()) return;

    if (event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this._onAccept();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this._onDismiss();
    }
  }

  _isSuggestionVisible() {
    const el = document.getElementById("ta-ghost");
    return el
      && el.style.display !== "none"
      && (el.classList.contains("ta-ghost--visible") || el.classList.contains("ta-ghost--loading"));
  }
}
