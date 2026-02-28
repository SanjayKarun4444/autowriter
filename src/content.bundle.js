/**
 * content.bundle.js — Typeahead v3.0 (Canvas-Mode Docs)
 *
 * ROOT CAUSE OF ALL FAILURES:
 * Google Docs has migrated to canvas-based rendering. The document text
 * is painted onto <canvas> elements — there are ZERO .kix-paragraphrenderer
 * or .kix-lineview DOM nodes. All previous text extraction was reading
 * empty selectors and sending blank prompts to the LLM.
 *
 * SOLUTIONS:
 *
 * 1. TEXT EXTRACTION — Clipboard API
 *    The only reliable way to read canvas-mode Docs text is via the clipboard.
 *    We periodically select all + copy + read clipboard + restore cursor.
 *    Cached every 4s to avoid UX disruption.
 *
 * 2. CURSOR CONTEXT — Selection API on iframe
 *    iframe.contentDocument.defaultView.getSelection() works even in canvas
 *    mode and gives us text near the cursor without clipboard.
 *
 * 3. TEXT INJECTION — InputEvent with inputType:'insertText'
 *    execCommand('insertText') returns false in canvas mode (Chrome 110+).
 *    Native InputEvent with inputType:'insertText' is what Docs listens for.
 *
 * 4. MUTATION OBSERVATION — observe iframe body too
 *    In canvas mode the main editor DOM barely mutates. We also observe
 *    the iframe's body to catch keystrokes reliably.
 */

(function () {
  "use strict";
  if (window.__typeaheadV3) return;
  window.__typeaheadV3 = true;

  /* ═══════════════════════════════════════════════════════════
     UTILITY
  ═══════════════════════════════════════════════════════════ */

  function debounce(ms, fn) {
    let t = null;
    const d = function() {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(function() { t = null; fn.apply(null, args); }, ms);
    };
    d.cancel = function() { clearTimeout(t); t = null; };
    return d;
  }

  function getIframe() {
    return document.querySelector(".docs-texteventtarget-iframe");
  }

  function getIframeDoc() {
    try {
      const f = getIframe();
      return f ? (f.contentDocument || f.contentWindow.document) : null;
    } catch(e) { return null; }
  }

  function getIframeTarget() {
    const iDoc = getIframeDoc();
    return iDoc ? iDoc.querySelector("[contenteditable='true']") : null;
  }

  /* ═══════════════════════════════════════════════════════════
     CONTEXT MANAGER — Canvas-mode compatible
  ═══════════════════════════════════════════════════════════ */

  var ContextManager = (function() {
    var cachedFullText = "";
    var cachedLocalText = "";
    var lastClipboardExtract = 0;
    var isExtracting = false;

    async function extractViaClipboard() {
      if (isExtracting) return;
      const now = Date.now();
      if (now - lastClipboardExtract < 4000) return;

      isExtracting = true;
      lastClipboardExtract = now;

      const iDoc = getIframeDoc();
      const target = getIframeTarget();
      if (!iDoc || !target) { isExtracting = false; return; }

      try {
        // Save current selection
        const sel = iDoc.defaultView.getSelection();
        const savedRange = sel && sel.rangeCount > 0
          ? sel.getRangeAt(0).cloneRange() : null;

        // Select all and copy
        target.focus();
        iDoc.execCommand("selectAll");
        iDoc.execCommand("copy");

        await new Promise(r => setTimeout(r, 100));

        // Read clipboard
        const text = await navigator.clipboard.readText();
        if (text && text.length > 5) {
          cachedFullText = text.trim();
          console.debug("[Typeahead] Extracted", cachedFullText.length, "chars via clipboard");
        }

        // Restore selection
        if (savedRange && sel) {
          sel.removeAllRanges();
          sel.addRange(savedRange);
        }
      } catch(e) {
        console.debug("[Typeahead] Clipboard extract failed:", e.message);
      }

      isExtracting = false;
    }

    function buildLocalContext() {
      if (!cachedFullText) return "";

      // Try to get cursor position from iframe selection
      const iDoc = getIframeDoc();
      try {
        const sel = iDoc && iDoc.defaultView.getSelection();
        if (sel && sel.rangeCount > 0 && sel.anchorNode && sel.anchorNode.textContent) {
          const cursorText = sel.anchorNode.textContent.slice(0, sel.anchorOffset);
          if (cursorText.length > 10) {
            const searchStr = cursorText.slice(-30);
            const idx = cachedFullText.lastIndexOf(searchStr);
            if (idx !== -1) {
              const upTo = cachedFullText.slice(0, idx + cursorText.length);
              cachedLocalText = upTo.length > 500 ? upTo.slice(-500) : upTo;
              return cachedLocalText;
            }
          }
        }
      } catch(e) {}

      // Fallback: last 500 chars of full text
      cachedLocalText = cachedFullText.length > 500
        ? cachedFullText.slice(-500) : cachedFullText;
      return cachedLocalText;
    }

    return {
      onMutated: function() { extractViaClipboard(); },
      forceExtract: function() { lastClipboardExtract = 0; extractViaClipboard(); },
      getContext: function() {
        const immediate = buildLocalContext();
        return {
          immediate,
          docSummary: cachedFullText.length > 600
            ? cachedFullText.slice(0, 250) + "\n…\n" + cachedFullText.slice(-250)
            : cachedFullText,
          wordCount: cachedFullText.split(/\s+/).filter(Boolean).length
        };
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     GHOST RENDERER
  ═══════════════════════════════════════════════════════════ */

  var GhostRenderer = (function() {
    var el = null, pip = null, rafId = null;
    var renderState = "hidden";
    var currentText = "";
    var pendingHide = false;

    function build() {
      el = document.createElement("span");
      el.id = "ta-ghost";
      el.setAttribute("aria-hidden", "true");
      Object.assign(el.style, {
        position: "fixed", zIndex: "2147483647",
        pointerEvents: "none", userSelect: "none",
        display: "none", whiteSpace: "pre",
        opacity: "0", transition: "opacity 120ms ease-out",
        fontStyle: "italic",
        color: "rgba(80,80,110,0.55)", top: "0", left: "0"
      });
      el.addEventListener("transitionend", function() {
        if (pendingHide && parseFloat(el.style.opacity) < 0.01) {
          el.style.display = "none";
          el.textContent = "";
          pendingHide = false;
        }
      });
      document.body.appendChild(el);

      pip = document.createElement("div");
      pip.id = "ta-pip";
      Object.assign(pip.style, {
        position: "fixed", bottom: "20px", right: "20px",
        zIndex: "2147483646", display: "none", alignItems: "center",
        padding: "5px 12px 5px 9px",
        background: "rgba(13,13,18,0.93)",
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.09)", borderRadius: "999px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "11.5px", fontWeight: "500", color: "rgba(180,180,200,0.9)",
        boxShadow: "0 2px 16px rgba(0,0,0,0.3)", pointerEvents: "none",
        opacity: "0", transform: "translateY(6px)",
        transition: "opacity 180ms ease-out, transform 180ms ease-out"
      });
      pip.innerHTML =
        '<span id="ta-dot" style="width:6px;height:6px;border-radius:50%;' +
        'background:rgba(91,94,244,0.9);display:inline-block;margin-right:6px"></span>' +
        '<span id="ta-label">Typeahead</span>';
      document.body.appendChild(pip);

      window.addEventListener("scroll", syncPos, { passive: true, capture: true });
      window.addEventListener("resize", syncPos, { passive: true });
    }

    function syncPos() {
      if (renderState === "hidden" || !el) return;
      const caret = document.querySelector(".kix-cursor-caret")
                 || document.querySelector(".kix-cursor");
      if (!caret) return;
      const r = caret.getBoundingClientRect();
      if (!r.width && !r.height) return;
      el.style.left = r.right + "px";
      el.style.top  = r.top  + "px";
    }

    function matchFont() {
      Object.assign(el.style, {
        fontFamily: "Arial, sans-serif",
        fontSize:   "11pt",
        fontWeight: "400",
        lineHeight: "1.15",
      });
    }

    function startLoop() {
      stopLoop();
      function loop() {
        if (renderState === "hidden") return;
        syncPos();
        rafId = requestAnimationFrame(loop);
      }
      rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function showPip(mode) {
      if (!pip) return;
      const dot = document.getElementById("ta-dot");
      const label = document.getElementById("ta-label");
      pip.style.display = "flex";
      if (mode === "loading") {
        if (dot)   dot.style.background = "rgba(245,158,11,0.9)";
        if (label) label.textContent = "Generating…";
      } else {
        if (dot)   dot.style.background = "rgba(91,94,244,0.9)";
        if (label) label.textContent = "Tab to accept  ·  Esc to dismiss";
      }
      requestAnimationFrame(function() { requestAnimationFrame(function() {
        if (pip) { pip.style.opacity = "1"; pip.style.transform = "translateY(0)"; }
      }); });
    }

    function hidePip() {
      if (!pip) return;
      pip.style.opacity = "0"; pip.style.transform = "translateY(6px)";
      const p = pip;
      function once() { p.style.display = "none"; p.removeEventListener("transitionend", once); }
      p.addEventListener("transitionend", once);
    }

    return {
      attach: function() { build(); },

      showLoading: function() {
        if (!el) return;
        pendingHide = false; renderState = "loading"; currentText = "";
        el.textContent = " …";
        el.style.color = "rgba(80,80,110,0.28)";
        el.style.display = "inline"; el.style.opacity = "0";
        syncPos(); matchFont(); startLoop(); showPip("loading");
        requestAnimationFrame(function() { requestAnimationFrame(function() {
          if (renderState !== "hidden" && el) el.style.opacity = "1";
        }); });
      },

      show: function(text) {
        if (!el || !text || !text.trim()) return;
        pendingHide = false; renderState = "visible";
        currentText = text.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ");
        el.textContent = currentText;
        el.style.color = "rgba(80,80,110,0.55)";
        el.style.display = "inline";
        syncPos(); matchFont(); startLoop(); showPip("active");
        requestAnimationFrame(function() { requestAnimationFrame(function() {
          if (renderState !== "hidden" && el) el.style.opacity = "1";
        }); });
      },

      hide: function() {
        if (!el || renderState === "hidden") return;
        renderState = "hidden"; currentText = ""; pendingHide = true;
        stopLoop(); hidePip(); el.style.opacity = "0";
        setTimeout(function() {
          if (pendingHide && el) { el.style.display = "none"; el.textContent = ""; pendingHide = false; }
        }, 200);
      },

      dissolve: function() {
        if (!el) return;
        renderState = "hidden"; currentText = ""; pendingHide = true;
        stopLoop(); hidePip();
        el.style.transition = "opacity 80ms ease-in"; el.style.opacity = "0";
        setTimeout(function() {
          if (el) { el.style.display = "none"; el.textContent = ""; el.style.transition = "opacity 120ms ease-out"; pendingHide = false; }
        }, 90);
      },

      getText:   function() { return currentText; },
      getState:  function() { return renderState; },
      isVisible: function() { return renderState === "visible"; }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     INJECTOR — Canvas-mode compatible
     InputEvent with inputType:'insertText' is what Docs listens
     for in canvas mode. execCommand returns false here (Chrome 110+).
  ═══════════════════════════════════════════════════════════ */

  var Injector = (function() {
    function simulateKeys(target, text) {
      let i = 0;
      function next() {
        if (i >= text.length) return;
        const ch = text[i++];
        const opts = { key: ch, char: ch, bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new KeyboardEvent("keydown",  opts));
        target.dispatchEvent(new KeyboardEvent("keypress", opts));
        target.dispatchEvent(new InputEvent("input", {
          inputType: "insertText", data: ch,
          bubbles: true, cancelable: false, composed: true
        }));
        target.dispatchEvent(new KeyboardEvent("keyup", opts));
        setTimeout(next, 12);
      }
      next();
    }

    return {
      insert: function(text) {
        if (!text) return false;
        const target = getIframeTarget();
        if (!target) { console.warn("[Typeahead] No iframe target"); return false; }

        target.focus();

        // Method 1: beforeinput + input (canvas-mode Docs listens to these)
        try {
          target.dispatchEvent(new InputEvent("beforeinput", {
            inputType: "insertText", data: text,
            bubbles: true, cancelable: true, composed: true
          }));
          target.dispatchEvent(new InputEvent("input", {
            inputType: "insertText", data: text,
            bubbles: true, cancelable: false, composed: true
          }));
          console.log("[Typeahead] Injected via InputEvent ✓");
          return true;
        } catch(e) { console.warn("[Typeahead] InputEvent failed:", e.message); }

        // Method 2: execCommand
        try {
          const iDoc = getIframeDoc();
          if (iDoc && iDoc.execCommand("insertText", false, text)) {
            console.log("[Typeahead] Injected via execCommand ✓");
            return true;
          }
        } catch(e) {}

        // Method 3: key simulation (slow fallback)
        console.warn("[Typeahead] Falling back to key simulation");
        simulateKeys(target, text);
        return true;
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     INPUT CONTROLLER
  ═══════════════════════════════════════════════════════════ */

  var InputController = (function() {
    var cbs = { onAccept: null, onDismiss: null, onType: null };
    var attachedIframe = null;
    var ready = false;
    var composing = false;

    function handleKey(e) {
      if (!ready || composing) return;
      const s = GhostRenderer.getState();

      if (e.key === "Tab" && s !== "hidden") {
        e.preventDefault();
        e.stopImmediatePropagation();
        cbs.onAccept && cbs.onAccept();
        return;
      }
      if (e.key === "Escape" && s !== "hidden") {
        e.preventDefault();
        e.stopImmediatePropagation();
        cbs.onDismiss && cbs.onDismiss();
        return;
      }
      if (s !== "hidden") {
        const printable = e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter";
        if (printable && !e.ctrlKey && !e.metaKey) cbs.onType && cbs.onType();
      }
    }

    function attachToDoc(doc) {
      doc.addEventListener("keydown",          handleKey,                        { capture: true });
      doc.addEventListener("compositionstart", function() { composing = true;  },{ capture: true });
      doc.addEventListener("compositionend",   function() { composing = false; },{ capture: true });
    }

    function tryAttachIframe() {
      const iframe = getIframe();
      if (!iframe || iframe === attachedIframe) return;
      try {
        const iDoc = getIframeDoc();
        if (iDoc) { attachToDoc(iDoc); attachedIframe = iframe; console.log("[Typeahead] Attached to iframe ✓"); }
      } catch(e) {}
    }

    return {
      init: function(callbacks) {
        Object.assign(cbs, callbacks);
        attachToDoc(document);
        tryAttachIframe();
        new MutationObserver(tryAttachIframe).observe(document.body, { childList: true, subtree: true });
      },
      setReady: function() { ready = true; }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     SUGGESTION ENGINE
  ═══════════════════════════════════════════════════════════ */

  var SuggestionEngine = (function() {
    var generation = 0;

    function sendMsg(prompt, gen, phase, cb) {
      if (!chrome.runtime || !chrome.runtime.id) { cb(new Error("Extension context invalidated"), null); return; }
      try {
        chrome.runtime.sendMessage(
          { type: "GET_COMPLETION", context: prompt, generation: gen, phase: phase },
          function(response) {
            const err = chrome.runtime.lastError;
            if (err)       return cb(new Error(err.message), null);
            if (!response) return cb(new Error("No response"), null);
            if (response.type === "COMPLETION_ERROR") return cb(new Error(response.error || "unknown"), null);
            cb(null, response.text || "");
          }
        );
      } catch(e) { cb(e, null); }
    }

    function buildPrompt(ctx) {
      const parts = [];
      if (ctx.docSummary && ctx.docSummary !== ctx.immediate && ctx.docSummary.length > 20) {
        parts.push("=== Document context ===\n" + ctx.docSummary);
      }
      if (ctx.immediate && ctx.immediate.trim().length > 0) {
        parts.push("=== Continue this text naturally (do not repeat it) ===\n" + ctx.immediate);
      }
      return parts.join("\n\n");
    }

    return {
      cancel: function() { generation++; },

      trigger: function(onUpdate) {
        const ctx = ContextManager.getContext();
        if (!ctx.immediate || ctx.immediate.trim().length < 12) {
          console.debug("[Typeahead] Context too short:", JSON.stringify(ctx.immediate));
          GhostRenderer.hide();
          return;
        }

        const myGen = ++generation;
        const prompt = buildPrompt(ctx);
        console.debug("[Typeahead] Prompt tail:", prompt.slice(-120));

        sendMsg(prompt, myGen, 1, function(err, text) {
          if (generation !== myGen) return;
          if (err) { console.warn("[Typeahead] P1 error:", err.message); GhostRenderer.hide(); return; }
          if (text && text.trim()) onUpdate(text);
          else GhostRenderer.hide();
        });

        setTimeout(function() {
          if (generation !== myGen) return;
          sendMsg(prompt, myGen, 2, function(err, text) {
            if (generation !== myGen) return;
            if (!err && text && text.trim() && GhostRenderer.getState() !== "hidden"
                && text.trim() !== GhostRenderer.getText().trim()) {
              onUpdate(text);
            }
          });
        }, 1500);
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     ORCHESTRATOR
  ═══════════════════════════════════════════════════════════ */

  var enabled = true;

  var debouncedTrigger = debounce(600, function() {
    if (!enabled) return;
    GhostRenderer.showLoading();
    SuggestionEngine.trigger(function(suggestion) {
      if (GhostRenderer.getState() === "hidden") return;
      GhostRenderer.show(suggestion);
    });
  });

  function mount(editorEl) {
    GhostRenderer.attach();

    InputController.init({
      onAccept: function() {
        const text = GhostRenderer.getText();
        if (!text) return;
        GhostRenderer.dissolve();
        SuggestionEngine.cancel();
        debouncedTrigger.cancel();
        Injector.insert(text);
      },
      onDismiss: function() {
        SuggestionEngine.cancel();
        debouncedTrigger.cancel();
        GhostRenderer.hide();
      },
      onType: function() {
        GhostRenderer.hide();
        SuggestionEngine.cancel();
      }
    });

    InputController.setReady();
    ContextManager.forceExtract();

    const mutObs = new MutationObserver(function() {
      if (!enabled) return;
      ContextManager.onMutated();
      GhostRenderer.hide();
      SuggestionEngine.cancel();
      debouncedTrigger();
    });

    mutObs.observe(editorEl, { childList: true, subtree: true, characterData: true });

    // Also observe iframe body — canvas mode mutations happen there
    const iDoc = getIframeDoc();
    if (iDoc && iDoc.body) {
      mutObs.observe(iDoc.body, { childList: true, subtree: true, characterData: true });
      console.log("[Typeahead] Observing iframe body ✓");
    }

    chrome.runtime.onMessage.addListener(function(msg) {
      if (msg.type === "SET_ENABLED") {
        enabled = msg.enabled;
        if (!enabled) { SuggestionEngine.cancel(); debouncedTrigger.cancel(); GhostRenderer.hide(); }
      }
    });

    console.log("[Typeahead v3.0] ✓ Mounted (canvas-mode)");
  }

  function waitForEditor() {
    return new Promise(function(resolve, reject) {
      const start = Date.now();
      (function poll() {
        const el = document.querySelector(".kix-appview-editor");
        if (el) return resolve(el);
        if (Date.now() - start > 20000) return reject(new Error("Editor not found"));
        setTimeout(poll, 400);
      })();
    });
  }

  chrome.storage.sync.get(["enabled"], function(prefs) {
    enabled = prefs.enabled !== false;
    console.log("[Typeahead v3.0] Starting, enabled =", enabled);
    waitForEditor().then(mount).catch(function(e) {
      console.warn("[Typeahead v3.0] Mount failed:", e.message);
    });
  });

})();