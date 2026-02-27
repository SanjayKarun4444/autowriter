/**
 * floatingToolbar.js — Selection-triggered AI action toolbar
 *
 * Shows a premium pill-shaped floating menu when the user selects text.
 * Behaves like a native macOS popover — glass blur, smooth scale-in,
 * smart positioning (stays inside viewport).
 *
 * Never pollutes Google Docs' DOM — the toolbar is appended to <body>
 * and positioned via fixed coords derived from Selection.getRangeAt().
 */

export class FloatingToolbar {

  constructor({ onImprove, onShorter, onLonger }) {
    this._el = null;
    this._callbacks = { onImprove, onShorter, onLonger };
    this._hideTimer = null;
    this._onSelect = this._handleSelection.bind(this);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  attach() {
    this._el = this._createElement();
    document.body.appendChild(this._el);

    document.addEventListener("mouseup",  this._onSelect);
    document.addEventListener("keyup",    this._onSelect);
    document.addEventListener("mousedown", this._onOutsideClick.bind(this));
  }

  detach() {
    document.removeEventListener("mouseup",  this._onSelect);
    document.removeEventListener("keyup",    this._onSelect);
    this._el?.remove();
    this._el = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _createElement() {
    const el = document.createElement("div");
    el.id = "ta-toolbar";
    el.setAttribute("data-typeahead", "");
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", "AI actions");
    el.innerHTML = `
      <button class="ta-toolbar__btn ta-toolbar__btn--primary" data-action="improve">
        <svg class="ta-toolbar__btn__icon" viewBox="0 0 14 14" fill="none">
          <path d="M7 1L8.5 5.5H13L9.5 8.5L11 13L7 10L3 13L4.5 8.5L1 5.5H5.5L7 1Z"
                stroke="currentColor" stroke-width="1.3"
                stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
        Improve
      </button>

      <div class="ta-toolbar__sep"></div>

      <button class="ta-toolbar__btn" data-action="shorter">
        <svg class="ta-toolbar__btn__icon" viewBox="0 0 14 14" fill="none">
          <path d="M2 4H12M4 7H10M6 10H8" stroke="currentColor"
                stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        Shorter
      </button>

      <button class="ta-toolbar__btn" data-action="longer">
        <svg class="ta-toolbar__btn__icon" viewBox="0 0 14 14" fill="none">
          <path d="M2 4H12M2 7H12M2 10H8" stroke="currentColor"
                stroke-width="1.3" stroke-linecap="round"/>
        </svg>
        Longer
      </button>
    `;

    el.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const selectedText = this._getSelectedText();
      if (!selectedText) return;

      this._hide();
      if (action === "improve") this._callbacks.onImprove?.(selectedText);
      if (action === "shorter") this._callbacks.onShorter?.(selectedText);
      if (action === "longer")  this._callbacks.onLonger?.(selectedText);
    });

    return el;
  }

  _handleSelection() {
    // Small delay to let selection finalise after mouseup
    setTimeout(() => {
      const text = this._getSelectedText();
      if (text && text.length > 10) {
        this._show();
      } else {
        this._hide();
      }
    }, 80);
  }

  _show() {
    const rect = this._getSelectionRect();
    if (!rect) return;

    const toolbarWidth = 230; // approximate
    const toolbarHeight = 36;
    const gap = 8;

    let top  = rect.top - toolbarHeight - gap;
    let left = rect.left + (rect.width / 2) - (toolbarWidth / 2);

    // Clamp to viewport
    if (top < 8) top = rect.bottom + gap;
    if (left < 8) left = 8;
    if (left + toolbarWidth > window.innerWidth - 8) {
      left = window.innerWidth - toolbarWidth - 8;
    }

    Object.assign(this._el.style, {
      top:  `${top}px`,
      left: `${left}px`,
    });

    this._el.classList.add("ta-toolbar--visible");
  }

  _hide() {
    this._el?.classList.remove("ta-toolbar--visible");
  }

  _onOutsideClick(e) {
    if (this._el && !this._el.contains(e.target)) {
      this._hide();
    }
  }

  _getSelectedText() {
    return window.getSelection()?.toString().trim() || "";
  }

  _getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    return sel.getRangeAt(0).getBoundingClientRect();
  }
}
