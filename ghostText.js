/**
 * ghostText.js — Premium ghost text renderer
 *
 * Creates and manages the floating overlay div that shows AI suggestions
 * on top of Google Docs without touching its DOM.
 *
 * Key design decisions:
 *  • Uses position:fixed + rAF loop for smooth cursor tracking
 *  • Inherits font metrics from the cursor line for pixel-accurate alignment
 *  • Three visual states: loading (shimmer), visible (ghost), accepting (dissolve)
 *  • text-shadow trick: the text has no fill, only a shadow — this means
 *    it renders identically to Docs text visually but can never cause
 *    layout issues or interact with Docs' selection system
 */

export class GhostTextRenderer {

  constructor() {
    this._el = null;
    this._pipEl = null;
    this._rafId = null;
    this._visible = false;
    this._currentText = "";
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  attach() {
    this._el = this._createGhostEl();
    this._pipEl = this._createPipEl();
    document.body.appendChild(this._el);
    document.body.appendChild(this._pipEl);

    // Keep ghost aligned during scroll / zoom
    window.addEventListener("scroll", this._onScroll, { passive: true, capture: true });
    window.addEventListener("resize", this._onScroll, { passive: true });
  }

  detach() {
    this._stopLoop();
    window.removeEventListener("scroll", this._onScroll, { capture: true });
    window.removeEventListener("resize", this._onScroll);
    this._el?.remove();
    this._pipEl?.remove();
    this._el = null;
    this._pipEl = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Show a shimmer bar while the AI is generating */
  showLoading() {
    if (!this._el) return;
    this._el.textContent = "";
    this._el.className = "ta-ghost--loading";
    this._el.style.display = "inline-block";
    this._visible = true;
    this._updatePosition();
    this._startLoop();
    this._updatePip("loading", "Generating…");
  }

  /** Show the completed suggestion text */
  show(text) {
    if (!this._el || !text?.trim()) return;

    const sanitized = text
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trimStart(); // don't prepend space — already handled by caller

    this._currentText = sanitized;
    this._el.textContent = sanitized;
    this._el.className = "";
    this._el.style.display = "inline";
    this._visible = true;

    this._updatePosition();
    this._matchDocsFontStyle();

    // Trigger fade-in on next frame (allows display:inline to take effect first)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this._el) this._el.classList.add("ta-ghost--visible");
      });
    });

    this._startLoop();
    this._updatePip("active", "Typeahead");
  }

  /** Instantly hide (on keypress / dismiss) */
  hide() {
    if (!this._el || !this._visible) return;
    this._visible = false;
    this._currentText = "";
    this._el.classList.remove("ta-ghost--visible", "ta-ghost--loading");
    this._el.style.display = "none";
    this._stopLoop();
    this._updatePip("idle", "Typeahead");
  }

  /** Dissolve animation when accepting (Tab) */
  accept() {
    if (!this._el) return;
    this._el.classList.remove("ta-ghost--visible");
    this._el.classList.add("ta-ghost--accepting");
    this._visible = false;
    this._stopLoop();

    setTimeout(() => {
      if (this._el) {
        this._el.classList.remove("ta-ghost--accepting");
        this._el.style.display = "none";
        this._el.textContent = "";
      }
    }, 130);

    this._updatePip("active", "Typeahead");
  }

  getText() {
    return this._currentText;
  }

  isVisible() {
    return this._visible;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _createGhostEl() {
    const el = document.createElement("span");
    el.id = "ta-ghost";
    el.setAttribute("data-typeahead", "");
    el.setAttribute("aria-hidden", "true");
    el.style.display = "none";
    return el;
  }

  _createPipEl() {
    const el = document.createElement("div");
    el.id = "ta-status-pip";
    el.setAttribute("data-typeahead", "");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `
      <span class="ta-pip__dot"></span>
      <span class="ta-pip__text">Typeahead</span>
    `;
    return el;
  }

  _updatePip(state, label) {
    if (!this._pipEl) return;
    const dot  = this._pipEl.querySelector(".ta-pip__dot");
    const text = this._pipEl.querySelector(".ta-pip__text");

    if (state === "idle") {
      this._pipEl.classList.remove("ta-pip--visible");
      return;
    }

    this._pipEl.classList.add("ta-pip--visible");
    text.textContent = label;

    if (state === "loading") {
      dot.classList.add("ta-pip__dot--loading");
    } else {
      dot.classList.remove("ta-pip__dot--loading");
    }
  }

  _onScroll = () => {
    if (this._visible) this._updatePosition();
  };

  _updatePosition() {
    const caret = this._findCaret();
    if (!caret) return;

    const rect = caret.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0) return; // caret not visible

    Object.assign(this._el.style, {
      left: `${rect.right}px`,
      top:  `${rect.top}px`,
    });
  }

  /**
   * Reads computed font styles from the text span nearest the cursor
   * and applies them to the ghost overlay for visual consistency.
   *
   * Called once per new suggestion (not per frame) — it's not expensive
   * but there's no value in calling it 60x/second.
   */
  _matchDocsFontStyle() {
    const caret = this._findCaret();
    if (!caret) return;

    const lineview = caret.closest(".kix-lineview");
    const span = lineview?.querySelector(".kix-lineview-text-block span")
              ?? lineview?.querySelector("span");
    if (!span) return;

    const s = window.getComputedStyle(span);
    Object.assign(this._el.style, {
      fontFamily:    s.fontFamily,
      fontSize:      s.fontSize,
      fontWeight:    s.fontWeight,
      lineHeight:    s.lineHeight,
      letterSpacing: s.letterSpacing,
    });
  }

  _findCaret() {
    return (
      document.querySelector(".kix-cursor-caret") ||
      document.querySelector(".kix-cursor")
    );
  }

  _startLoop() {
    this._stopLoop();
    const loop = () => {
      if (!this._visible) return;
      this._updatePosition();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _stopLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}
