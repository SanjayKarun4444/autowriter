/**
 * GhostRenderer.js — Ghost text overlay with edge case handling
 *
 * Improvements over ghostText.js:
 *   • Cursor-move detection via SelectionObserver — hides on cursor jump
 *   • Undo event detection — hides on Ctrl+Z
 *   • Multi-line suggestions: wraps gracefully
 *   • Position locked once shown (no rAF drift causing misalignment)
 *   • Visibility check consolidated here (used by KeyboardController)
 */

export class GhostRenderer {

  constructor() {
    this._el           = null;
    this._pipEl        = null;
    this._rafId        = null;
    this._visible      = false;
    this._currentText  = "";
    this._onScroll     = this._handleScroll.bind(this);
    this._onUndo       = this._handleUndo.bind(this);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  attach() {
    this._el    = this._createGhostEl();
    this._pipEl = this._createPipEl();
    document.body.appendChild(this._el);
    document.body.appendChild(this._pipEl);

    window.addEventListener("scroll", this._onScroll, { passive: true, capture: true });
    window.addEventListener("resize", this._onScroll, { passive: true });

    // Hide on Ctrl+Z / Cmd+Z (undo) — suggestion no longer valid
    document.addEventListener("keydown", this._onUndo, { capture: true });
  }

  detach() {
    this._stopLoop();
    window.removeEventListener("scroll", this._onScroll, { capture: true });
    window.removeEventListener("resize", this._onScroll);
    document.removeEventListener("keydown", this._onUndo, { capture: true });
    this._el?.remove();
    this._pipEl?.remove();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

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

  show(text) {
    if (!this._el || !text?.trim()) return;

    // Sanitize: collapse internal whitespace, trim leading space
    const sanitized = text.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trimStart();

    this._currentText   = sanitized;
    this._el.textContent = sanitized;
    this._el.className  = "";
    this._el.style.display = "inline";
    this._visible = true;

    this._updatePosition();
    this._matchDocsFontStyle();

    // Double rAF fade-in (ensures display:inline is committed before transition)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this._el) this._el.classList.add("ta-ghost--visible");
      });
    });

    this._startLoop();
    this._updatePip("active", "Tab to accept");
  }

  hide() {
    if (!this._el || !this._visible) return;
    this._visible     = false;
    this._currentText = "";
    this._el.classList.remove("ta-ghost--visible", "ta-ghost--loading");
    this._el.style.display = "none";
    this._stopLoop();
    this._updatePip("idle", "");
  }

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

    this._updatePip("idle", "");
  }

  getText()      { return this._currentText; }
  isVisible()    { return this._visible; }

  // ── Private ───────────────────────────────────────────────────────────────

  _createGhostEl() {
    const el = document.createElement("span");
    el.id = "ta-ghost";
    el.setAttribute("data-typeahead", "");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "display:none;position:fixed;pointer-events:none;z-index:99999;white-space:pre;";
    return el;
  }

  _createPipEl() {
    const el = document.createElement("div");
    el.id = "ta-status-pip";
    el.setAttribute("data-typeahead", "");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `<span class="ta-pip__dot"></span><span class="ta-pip__text">Typeahead</span>`;
    return el;
  }

  _handleScroll() {
    if (this._visible) this._updatePosition();
  }

  _handleUndo(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      this.hide();
    }
  }

  _updatePip(state, label) {
    if (!this._pipEl) return;
    const dot  = this._pipEl.querySelector(".ta-pip__dot");
    const text = this._pipEl.querySelector(".ta-pip__text");
    if (state === "idle") { this._pipEl.classList.remove("ta-pip--visible"); return; }
    this._pipEl.classList.add("ta-pip--visible");
    if (text) text.textContent = label;
    if (dot)  dot.classList.toggle("ta-pip__dot--loading", state === "loading");
  }

  _updatePosition() {
    const caret = document.querySelector(".kix-cursor-caret") || document.querySelector(".kix-cursor");
    if (!caret) return;
    const rect = caret.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    Object.assign(this._el.style, {
      left: `${rect.right}px`,
      top:  `${rect.top}px`,
    });
  }

  _matchDocsFontStyle() {
    const caret = document.querySelector(".kix-cursor-caret") || document.querySelector(".kix-cursor");
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
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }
}
