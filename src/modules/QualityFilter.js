/**
 * QualityFilter.js — Heuristic quality scoring and validation
 *
 * Rejects suggestions that are:
 *   • Too short (< 4 words) — probably a hallucinated fragment
 *   • Generic openers — banned transition phrases
 *   • Repetitions of context the user already wrote
 *   • AI-like / robotic phrasing
 *   • Starting with a capital letter when they shouldn't (sentence restarts)
 *   • Suspiciously identical to common filler from the mock provider
 */

export class QualityFilter {

  // Minimum acceptable word count for a suggestion
  static MIN_WORDS = 4;

  // Score threshold below which we reject (0–100 scale, lower = worse)
  static REJECT_THRESHOLD = 40;

  /**
   * Validates a suggestion against the context.
   * @param {string} suggestion
   * @param {object} ctx — from ContextManager.extract()
   * @returns {{ valid: boolean, score: number, reason: string }}
   */
  validate(suggestion, ctx) {
    if (!suggestion || !suggestion.trim()) {
      return { valid: false, score: 0, reason: "empty" };
    }

    const text = suggestion.trim();
    const words = text.split(/\s+/).filter(w => w.length > 0);

    // ── Hard rejections ──────────────────────────────────────────────────

    if (words.length < QualityFilter.MIN_WORDS) {
      return { valid: false, score: 10, reason: "too_short" };
    }

    // Check for banned generic openers
    const banned = this._checkBannedPhrases(text);
    if (banned) {
      return { valid: false, score: 15, reason: `banned_phrase:${banned}` };
    }

    // Check for repetition of existing text
    const repetition = this._checkRepetition(text, ctx);
    if (repetition) {
      return { valid: false, score: 20, reason: "repetition" };
    }

    // ── Scoring ──────────────────────────────────────────────────────────

    let score = 100;

    // Penalize AI-ish hedging phrases
    score -= this._countAIPhrases(text) * 15;

    // Penalize if suggestion starts with capital (suggests sentence restart, not continuation)
    // Exception: proper nouns are fine — heuristic: if active sentence doesn't end with space
    if (/^[A-Z]/.test(text) && ctx.activeSentence && !ctx.activeSentence.endsWith(" ")) {
      score -= 20;
    }

    // Reward natural continuations (starts with lowercase or with punctuation)
    if (/^[a-z,;—-]/.test(text)) score += 10;

    // Penalize very short suggestions (< 8 words) — not outright rejected but deprioritized
    if (words.length < 8) score -= 10;

    // Penalize suspiciously long suggestions (> 50 words — probably off-topic rambling)
    if (words.length > 50) score -= 25;

    // Penalize generic filler content
    score -= this._genericityScore(text) * 25;

    score = Math.max(0, Math.min(100, score));

    if (score < QualityFilter.REJECT_THRESHOLD) {
      return { valid: false, score, reason: "low_score" };
    }

    return { valid: true, score, reason: "ok" };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _checkBannedPhrases(text) {
    const banned = [
      /^in conclusion/i,
      /^in summary/i,
      /^to summarize/i,
      /^overall[,\s]/i,
      /^it is worth noting/i,
      /^it should be noted/i,
      /^it is important to/i,
      /^this is a complex/i,
      /^there are many/i,
      /^as (we|i) (can see|mentioned|discussed)/i,
      /^needless to say/i,
      /^at the end of the day/i,
      /^when all is said and done/i,
      /^last but not least/i,
    ];
    for (const pattern of banned) {
      if (pattern.test(text)) return pattern.source;
    }
    return null;
  }

  /**
   * Check if the suggestion substantially repeats text already in context.
   * Uses a sliding 4-gram overlap check.
   */
  _checkRepetition(suggestion, ctx) {
    if (!ctx?.fullContext) return false;
    const contextLower = ctx.fullContext.toLowerCase();
    const suggLower    = suggestion.toLowerCase();

    // Build 4-grams of suggestion
    const words = suggLower.split(/\s+/);
    if (words.length < 4) return false;

    let overlapping = 0;
    for (let i = 0; i <= words.length - 4; i++) {
      const gram = words.slice(i, i + 4).join(" ");
      if (contextLower.includes(gram)) overlapping++;
    }

    // If more than 40% of 4-grams already appear in context, it's a repetition
    const ratio = overlapping / (words.length - 3);
    return ratio > 0.4;
  }

  _countAIPhrases(text) {
    const patterns = [
      /\bcertainly\b/i, /\babsolutely\b/i, /\bof course\b/i,
      /\bindeed\b/i, /\bfascinating\b/i, /\binsightful\b/i,
      /\bsignificant(ly)?\b/i,  // overused
      /\bcomplex issue\b/i,
      /\bimportant (to note|aspect|factor)/i,
    ];
    return patterns.filter(p => p.test(text)).length;
  }

  /**
   * Returns a score 0–5 representing how "generic filler" the text is.
   */
  _genericityScore(text) {
    let score = 0;
    const genericPatterns = [
      /this approach has proven/i,
      /wide range of/i,
      /real.world applications/i,
      /merits (further|careful)/i,
      /worth (considering|exploring)/i,
      /further analysis (will|may)/i,
      /extent(s)? (well )?beyond/i,
      /making informed decisions/i,
      /additional insights/i,
    ];
    for (const p of genericPatterns) {
      if (p.test(text)) score++;
    }
    return score;
  }
}
