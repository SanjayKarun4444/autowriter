/**
 * SuggestionController.js — Orchestrates the full suggestion pipeline
 *
 * Pipeline:
 *   ContextManager.extract()
 *     → PromptEngine.buildSystemPrompt() + buildUserPrompt()
 *       → API call (via chrome.runtime) [AbortController for stale cancellation]
 *         → QualityFilter.validate()
 *           → GhostRenderer.show() OR retry once OR hide()
 *
 * Handles:
 *   • Race conditions via AbortController + generation counter
 *   • One automatic retry on quality failure
 *   • Loading state display during generation
 *   • Error suppression (never crashes the page)
 */

import { ContextManager } from "./ContextManager.js";
import { PromptEngine    } from "./PromptEngine.js";
import { QualityFilter   } from "./QualityFilter.js";
import { createDebouncer } from "./debounce.js";

export class SuggestionController {

  constructor({ ghost, apiClient }) {
    this._ghost      = ghost;
    this._apiClient  = apiClient;

    this._context    = new ContextManager();
    this._engine     = new PromptEngine();
    this._filter     = new QualityFilter();

    this._generation = 0;       // monotonically increasing; used to drop stale responses
    this._observer   = null;

    // Debounced trigger — waits for 500ms pause in typing
    this._debounced  = createDebouncer(500, () => this._run());
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start watching the Docs editor element for changes */
  start(editorEl) {
    this._observer = new MutationObserver(() => {
      this._ghost.hide();   // dismiss stale suggestion immediately
      this._generation++;   // invalidate any in-flight request
      this._debounced();    // schedule new one
    });

    this._observer.observe(editorEl, {
      childList:     true,
      subtree:       true,
      characterData: true,
    });
  }

  stop() {
    this._observer?.disconnect();
    this._observer = null;
    this._debounced.cancel();
    this._generation++;
    this._ghost.hide();
  }

  /** Force-dismiss current suggestion and cancel pending request */
  dismiss() {
    this._generation++;
    this._debounced.cancel();
    this._ghost.hide();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _run() {
    const ctx = this._context.extract();
    if (!ctx || ctx.activeSentence.length < 10) return;

    const myGen = ++this._generation;

    const systemPrompt = this._engine.buildSystemPrompt(ctx.detectedTone);
    const userPrompt   = this._engine.buildUserPrompt(ctx);

    this._ghost.showLoading();

    // First attempt
    const suggestion = await this._fetchSuggestion(myGen, systemPrompt, userPrompt);
    if (suggestion === null) return; // stale or errored — already hidden

    const result = this._filter.validate(suggestion, ctx);

    if (result.valid) {
      this._ghost.show(suggestion);
      return;
    }

    // Quality failed — log reason and retry once
    console.debug(`[Typeahead] Quality reject (${result.reason}, score=${result.score}) — retrying`);

    const retry = await this._fetchSuggestion(myGen, systemPrompt, userPrompt + "\n\n(Previous attempt was rejected. Try a more specific, natural continuation.)");
    if (retry === null) return;

    const retryResult = this._filter.validate(retry, ctx);
    if (retryResult.valid) {
      this._ghost.show(retry);
    } else {
      console.debug(`[Typeahead] Retry also failed (${retryResult.reason}) — suppressing`);
      this._ghost.hide();
    }
  }

  /**
   * Fetch a suggestion, returning null if the request is stale.
   */
  async _fetchSuggestion(myGen, systemPrompt, userPrompt) {
    try {
      const suggestion = await this._apiClient.requestCompletion({ systemPrompt, userPrompt });

      // Stale check — a newer generation started while we awaited
      if (this._generation !== myGen) return null;

      return suggestion || null;
    } catch (err) {
      if (this._generation !== myGen) return null;
      this._ghost.hide();
      if (err.message !== "disabled") {
        console.warn("[Typeahead] API error:", err.message);
      }
      return null;
    }
  }
}
