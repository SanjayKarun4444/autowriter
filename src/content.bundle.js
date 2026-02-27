/**
 * content.bundle.js — Typeahead v2
 *
 * WHY TAB/ESC FAILED BEFORE:
 * Google Docs routes ALL keyboard input through a sandboxed iframe
 * (.docs-texteventtarget-iframe). Events inside that iframe never bubble
 * to the parent document. Attaching to document capture phase only catches
 * outer-page events, not typing. Fix: attach to iframe.contentDocument too.
 *
 * WHY INJECTION FAILED:
 * textInput events are deprecated/ignored since Chrome 87. Simulating
 * keydown/keyup on the outer document also fails — Docs only processes
 * those when they originate inside the iframe.
 * Fix: execCommand('insertText') on the iframe's document object.
 *
 * WHY GHOST PERSISTED:
 * setTimeout-based hide had race conditions — a second hide() call during
 * the 160ms window would leave display:block. Fix: transitionend listener
 * as single source of truth for DOM cleanup.
 *
 * WHY CONTEXT WAS WRONG:
 * getTextBeforeCursor compared lineRect.bottom (vertical px) against
 * cursorX (horizontal px) — a straight dimensional bug. Fix: compare
 * vertical coordinates only.
 */

(function () {
  "use strict";
  if (window.__typeaheadV2) return;
  window.__typeaheadV2 = true;

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

  /* ═══════════════════════════════════════════════════════════
     CONTEXT MANAGER
     Maintains rolling memory: immediate context + doc summary.
     Summarisation is debounced at 3s — never runs per-keystroke.
  ═══════════════════════════════════════════════════════════ */

  var ContextManager = (function() {
    var memory = { immediate: "", docSummary: "", wordCount: 0 };
    var lastFullText = "";

    function getAllText() {
      var paras = document.querySelectorAll(".kix-paragraphrenderer");
      if (!paras.length) {
        var ed = document.querySelector(".kix-appview-editor");
        return ed ? ed.textContent.replace(/\u00A0/g, " ").trim() : "";
      }
      return Array.from(paras)
        .map(function(p) { return p.textContent.replace(/\u00A0/g, " ").trim(); })
        .filter(Boolean).join("\n");
    }

    function getLocalText() {
      var cursor = document.querySelector(".kix-cursor");
      var paras  = Array.from(document.querySelectorAll(".kix-paragraphrenderer"));
      if (!paras.length) return getAllText().slice(-600);

      var cursorParaIdx = paras.length - 1;
      if (cursor) {
        var cy = cursor.getBoundingClientRect().top;
        for (var i = 0; i < paras.length; i++) {
          var r = paras[i].getBoundingClientRect();
          if (cy >= r.top - 4 && cy <= r.bottom + 4) { cursorParaIdx = i; break; }
        }
      }

      var start = Math.max(0, cursorParaIdx - 4);
      var lines = paras.slice(start, cursorParaIdx + 1)
        .map(function(p) { return p.textContent.replace(/\u00A0/g, " ").trim(); })
        .filter(Boolean);
      var raw = lines.join(" ");

      if (raw.length <= 600) return raw;
      var chunk = raw.slice(-600);
      var boundary = chunk.search(/(?<=[.!?]\s)[A-Z]/);
      return boundary > 0 ? chunk.slice(boundary) : chunk;
    }

    function summarise() {
      var full = getAllText();
      if (full === lastFullText) return;
      lastFullText = full;
      memory.wordCount = full.split(/\s+/).filter(Boolean).length;
      if (full.length <= 600) {
        memory.docSummary = full;
      } else {
        memory.docSummary = full.slice(0, 280) + "\n…\n" + full.slice(-280);
      }
    }

    var debouncedSummarise = debounce(3000, summarise);
    setTimeout(summarise, 2000);

    return {
      onMutated: function() { debouncedSummarise(); },
      getContext: function() {
        memory.immediate = getLocalText();
        return {
          immediate:  memory.immediate,
          docSummary: memory.docSummary,
          wordCount:  memory.wordCount
        };
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     GHOST RENDERER
     Uses transitionend (not setTimeout) for hide cleanup.
     pendingHide flag prevents double-hide races.
  ═══════════════════════════════════════════════════════════ */

  var GhostRenderer = (function() {
    var el = null, pip = null, rafId = null;
    var renderState = "hidden"; // "hidden"|"loading"|"visible"
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
        willChange: "opacity", fontStyle: "italic",
        color: "rgba(80,80,110,0.45)", top: "0", left: "0"
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
        zIndex: "2147483646", display: "none",
        alignItems: "center", gap: "6px",
        padding: "5px 12px 5px 9px",
        background: "rgba(13,13,18,0.93)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.09)",
        borderRadius: "999px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "11.5px", fontWeight: "500",
        color: "rgba(180,180,200,0.9)",
        boxShadow: "0 2px 16px rgba(0,0,0,0.3)",
        pointerEvents: "none",
        WebkitFontSmoothing: "antialiased",
        opacity: "0", transform: "translateY(6px)",
        transition: "opacity 180ms ease-out, transform 180ms ease-out"
      });
      pip.innerHTML = '<span id="ta-dot" style="width:6px;height:6px;border-radius:50%;background:rgba(91,94,244,0.9);display:inline-block;flex-shrink:0"></span>'
                    + '<span id="ta-label" style="margin-left:6px">Typeahead</span>';
      document.body.appendChild(pip);

      window.addEventListener("scroll", syncPos, { passive: true, capture: true });
      window.addEventListener("resize", syncPos, { passive: true });
    }

    function syncPos() {
      if (renderState === "hidden" || !el) return;
      var caret = document.querySelector(".kix-cursor-caret") || document.querySelector(".kix-cursor");
      if (!caret) return;
      var r = caret.getBoundingClientRect();
      if (!r.width && !r.height) return;
      el.style.left = r.right + "px";
      el.style.top  = r.top  + "px";
    }

    function matchFont() {
      var caret = document.querySelector(".kix-cursor-caret") || document.querySelector(".kix-cursor");
      if (!caret) return;
      var line = caret.closest && caret.closest(".kix-lineview");
      var span = line && (line.querySelector(".kix-lineview-text-block span") || line.querySelector("span"));
      if (!span) return;
      var s = window.getComputedStyle(span);
      Object.assign(el.style, {
        fontFamily: s.fontFamily, fontSize: s.fontSize,
        fontWeight: s.fontWeight, lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing
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
      var dot   = document.getElementById("ta-dot");
      var label = document.getElementById("ta-label");
      pip.style.display = "flex";
      if (mode === "loading") {
        if (dot)   dot.style.background = "rgba(245,158,11,0.9)";
        if (label) label.textContent = "Generating…";
      } else {
        if (dot)   dot.style.background = "rgba(91,94,244,0.9)";
        if (label) label.textContent = "Tab to accept  ·  Esc to dismiss";
      }
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          if (pip) { pip.style.opacity = "1"; pip.style.transform = "translateY(0)"; }
        });
      });
    }

    function hidePip() {
      if (!pip) return;
      pip.style.opacity = "0";
      pip.style.transform = "translateY(6px)";
      var p = pip;
      function once() { p.style.display = "none"; p.removeEventListener("transitionend", once); }
      p.addEventListener("transitionend", once);
    }

    return {
      attach: function() { build(); },

      showLoading: function() {
        if (!el) return;
        pendingHide = false;
        renderState = "loading";
        currentText = "";
        el.textContent = " …";
        el.style.color = "rgba(80,80,110,0.28)";
        el.style.display = "inline";
        el.style.opacity = "0";
        syncPos(); matchFont(); startLoop(); showPip("loading");
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            if (renderState !== "hidden" && el) el.style.opacity = "1";
          });
        });
      },

      show: function(text) {
        if (!el || !text.trim()) return;
        pendingHide = false;
        renderState = "visible";
        currentText = text.replace(/\r?\n/g, " ").replace(/\s{2,}/g, " ");
        el.textContent = currentText;
        el.style.color = "rgba(80,80,110,0.45)";
        el.style.display = "inline";
        syncPos(); matchFont(); startLoop(); showPip("active");
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            if (renderState !== "hidden" && el) el.style.opacity = "1";
          });
        });
      },

      hide: function() {
        if (!el || renderState === "hidden") return;
        renderState = "hidden";
        currentText = "";
        pendingHide = true;
        stopLoop(); hidePip();
        el.style.opacity = "0";
        // Fallback if transitionend doesn't fire
        setTimeout(function() {
          if (pendingHide && el) { el.style.display = "none"; el.textContent = ""; pendingHide = false; }
        }, 200);
      },

      dissolve: function() {
        if (!el) return;
        renderState = "hidden";
        currentText = "";
        pendingHide = true;
        stopLoop(); hidePip();
        el.style.transition = "opacity 80ms ease-in";
        el.style.opacity = "0";
        setTimeout(function() {
          if (el) {
            el.style.display = "none"; el.textContent = "";
            el.style.transition = "opacity 120ms ease-out";
            pendingHide = false;
          }
        }, 90);
      },

      getText:   function() { return currentText; },
      getState:  function() { return renderState; },
      isVisible: function() { return renderState === "visible"; }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     INJECTOR
     execCommand('insertText') on the iframe document is the
     only reliable insertion method for modern Google Docs.
     textInput events are deprecated; keyboard simulation on
     the outer document is ignored by Docs.
  ═══════════════════════════════════════════════════════════ */

  var Injector = (function() {
    function getIframeDoc() {
      var iframe = document.querySelector(".docs-texteventtarget-iframe");
      if (!iframe) return null;
      try { return iframe.contentDocument || iframe.contentWindow.document; }
      catch(e) { return null; }
    }

    return {
      insert: function(text) {
        if (!text) return false;
        var iDoc = getIframeDoc();
        if (iDoc) {
          try {
            iDoc.body.focus();
            var ok = iDoc.execCommand("insertText", false, text);
            if (ok) { console.log("[Typeahead] Inserted via iframe execCommand"); return true; }
          } catch(e) {}
        }
        // Fallback
        var t = document.querySelector(".kix-typingcanvas") || document.querySelector("[contenteditable='true']");
        if (t) {
          t.focus();
          var ok2 = document.execCommand("insertText", false, text);
          if (ok2) { console.log("[Typeahead] Inserted via main doc execCommand"); return true; }
        }
        console.warn("[Typeahead] Injection failed — both strategies exhausted");
        return false;
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     INPUT CONTROLLER
     Attaches to BOTH outer document AND iframe contentDocument.
     Re-attaches if iframe is replaced by Docs.
  ═══════════════════════════════════════════════════════════ */

  var InputController = (function() {
    var cbs = { onAccept: null, onDismiss: null, onType: null };
    var attachedIframe = null;

    function handleKey(e) {
      var s = GhostRenderer.getState();

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
        var printable = e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter";
        if (printable) cbs.onType && cbs.onType();
      }
    }

    function tryAttachIframe() {
      var iframe = document.querySelector(".docs-texteventtarget-iframe");
      if (!iframe || iframe === attachedIframe) return;
      try {
        var iDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iDoc) {
          iDoc.addEventListener("keydown", handleKey, { capture: true });
          attachedIframe = iframe;
          console.log("[Typeahead] Attached keydown to Docs iframe ✓");
        }
      } catch(e) {}
    }

    return {
      init: function(callbacks) {
        Object.assign(cbs, callbacks);
        document.addEventListener("keydown", handleKey, { capture: true });
        tryAttachIframe();
        // Watch for iframe recreation
        var obs = new MutationObserver(tryAttachIframe);
        obs.observe(document.body, { childList: true, subtree: true });
      }
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     SUGGESTION ENGINE
     Generation counter (not random IDs) guarantees ordering.
     Phase 1 (fast) + optional Phase 2 (refined after 1.5s).
  ═══════════════════════════════════════════════════════════ */

  var SuggestionEngine = (function() {
    var generation = 0;

    function sendMsg(prompt, gen, phase, cb) {
      try {
        chrome.runtime.sendMessage(
          { type: "GET_COMPLETION", context: prompt, generation: gen, phase: phase },
          function(response) {
            if (chrome.runtime.lastError) return cb(new Error(chrome.runtime.lastError.message), null);
            if (!response)                return cb(new Error("No response"), null);
            if (response.type === "COMPLETION_ERROR") return cb(new Error(response.error), null);
            cb(null, response.text || "");
          }
        );
      } catch(e) { cb(e, null); }
    }

    function buildPrompt(ctx) {
      var parts = [];
      if (ctx.docSummary && ctx.docSummary !== ctx.immediate) {
        parts.push("=== Document context ===\n" + ctx.docSummary);
      }
      parts.push("=== Continue this text ===\n" + ctx.immediate);
      return parts.join("\n\n");
    }

    return {
      cancel: function() { generation++; },

      trigger: function(onUpdate) {
        var ctx = ContextManager.getContext();
        if (!ctx.immediate || ctx.immediate.length < 12) {
          GhostRenderer.hide();
          return;
        }

        var myGen = ++generation;
        var prompt = buildPrompt(ctx);

        // Phase 1 — immediate fast response
        sendMsg(prompt, myGen, 1, function(err, text) {
          if (generation !== myGen) return;
          if (err) { console.warn("[Typeahead] P1 error:", err.message); GhostRenderer.hide(); return; }
          if (text.trim()) onUpdate(text);
        });

        // Phase 2 — refined suggestion if still active after 1.5s
        setTimeout(function() {
          if (generation !== myGen) return;
          sendMsg(prompt, myGen, 2, function(err, text) {
            if (generation !== myGen) return;
            if (!err && text.trim() && text.trim() !== GhostRenderer.getText().trim()) {
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

  var debouncedTrigger = debounce(500, function() {
    if (!enabled) return;
    GhostRenderer.showLoading();
    SuggestionEngine.trigger(function(suggestion) {
      GhostRenderer.show(suggestion);
    });
  });

  function mount(editorEl) {
    GhostRenderer.attach();

    InputController.init({
      onAccept: function() {
        var text = GhostRenderer.getText();
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

    var mutObs = new MutationObserver(function() {
      if (!enabled) return;
      ContextManager.onMutated();
      GhostRenderer.hide();
      SuggestionEngine.cancel();
      debouncedTrigger();
    });
    mutObs.observe(editorEl, { childList: true, subtree: true, characterData: true });

    chrome.runtime.onMessage.addListener(function(msg) {
      if (msg.type === "SET_ENABLED") {
        enabled = msg.enabled;
        if (!enabled) { SuggestionEngine.cancel(); debouncedTrigger.cancel(); GhostRenderer.hide(); }
      }
    });

    console.log("[Typeahead v2] ✓ Mounted and ready");
  }

  function waitForEditor() {
    return new Promise(function(resolve, reject) {
      var start = Date.now();
      (function poll() {
        var el = document.querySelector(".kix-appview-editor");
        if (el) return resolve(el);
        if (Date.now() - start > 20000) return reject(new Error("Editor not found"));
        setTimeout(poll, 400);
      })();
    });
  }

  chrome.storage.sync.get(["enabled"], function(prefs) {
    enabled = prefs.enabled !== false;
    console.log("[Typeahead v2] Starting, enabled =", enabled);
    waitForEditor().then(mount).catch(function(e) {
      console.warn("[Typeahead v2] Mount failed:", e.message);
    });
  });

})();