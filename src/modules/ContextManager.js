/**
 * ContextManager.js — Rich context extraction for high-quality completions
 *
 * Extracts:
 *   • activeSentence   — the current incomplete sentence the user is writing
 *   • recentParagraphs — last 2–3 paragraphs for tone/style matching
 *   • documentSummary  — first ~200 chars (title + opening) as intent signal
 *   • detectedTone     — heuristic: formal | academic | casual | persuasive | narrative
 *
 * Why this matters:
 *   Without this, the LLM receives a raw 400-char text blob with no structure.
 *   It has no idea where the sentence starts, what the document is about, or
 *   what register the author is writing in — so it defaults to generic filler.
 */

export class ContextManager {

  /**
   * @returns {object|null} Structured context or null if cursor not found
   */
  extract() {
    const cursor = document.querySelector(".kix-cursor");
    if (!cursor) return null;

    const paragraphs = this._getAllParagraphTexts();
    if (!paragraphs.length) return null;

    const { beforeCursor, cursorParaIdx } = this._getTextBeforeCursor(cursor, paragraphs);
    if (!beforeCursor || beforeCursor.length < 10) return null;

    const activeSentence   = this._extractActiveSentence(beforeCursor);
    const recentParagraphs = this._getRecentParagraphs(paragraphs, cursorParaIdx);
    const documentSummary  = this._getDocumentSummary(paragraphs);
    const detectedTone     = this._inferTone(paragraphs.join(" "));

    return {
      activeSentence,
      recentParagraphs,
      documentSummary,
      detectedTone,
      fullContext: beforeCursor,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _getAllParagraphTexts() {
    return Array.from(document.querySelectorAll(".kix-paragraphrenderer"))
      .map(p => p.textContent.replace(/\u00A0/g, " ").trim())
      .filter(t => t.length > 0);
  }

  _getTextBeforeCursor(cursor, paragraphs) {
    const cursorRect = cursor.getBoundingClientRect();
    const paraEls = Array.from(document.querySelectorAll(".kix-paragraphrenderer"));

    let cursorParaIdx = paraEls.length - 1;
    for (let i = 0; i < paraEls.length; i++) {
      const r = paraEls[i].getBoundingClientRect();
      if (cursorRect.top >= r.top - 4 && cursorRect.top <= r.bottom + 4) {
        cursorParaIdx = i;
        break;
      }
    }

    // Build text: full paragraphs before cursor para + text-before-cursor in cursor para
    const beforeParas = paragraphs.slice(Math.max(0, cursorParaIdx - 4), cursorParaIdx);
    const cursorPara  = paraEls[cursorParaIdx]
      ? this._textBeforeCursorInPara(paraEls[cursorParaIdx], cursorRect.left)
      : (paragraphs[cursorParaIdx] || "");

    return {
      beforeCursor: [...beforeParas, cursorPara].join(" ").trim(),
      cursorParaIdx,
    };
  }

  _textBeforeCursorInPara(paraEl, cursorX) {
    let result = "";
    const lines = paraEl.querySelectorAll(".kix-lineview");

    for (const line of lines) {
      const lineRect = line.getBoundingClientRect();
      // Lines fully above cursor line
      if (lineRect.bottom < cursorX - 80) {
        result += line.textContent.replace(/\u00A0/g, " ");
        continue;
      }
      const spans = line.querySelectorAll(
        ".kix-lineview-text-block span, .kix-wordhtmlgenerator-word-node"
      );
      if (!spans.length) {
        result += line.textContent.replace(/\u00A0/g, " ");
        continue;
      }
      for (const span of spans) {
        const sr = span.getBoundingClientRect();
        if (sr.right <= cursorX + 2) {
          result += span.textContent.replace(/\u00A0/g, " ");
        } else if (sr.left < cursorX) {
          const t = span.textContent.replace(/\u00A0/g, " ");
          const ratio = (cursorX - sr.left) / (sr.width || 1);
          result += t.slice(0, Math.round(t.length * ratio));
          break;
        } else {
          break; // past cursor
        }
      }
    }
    return result;
  }

  /**
   * Extract the active (incomplete) sentence — the last sentence fragment
   * that the user is currently writing.
   */
  _extractActiveSentence(text) {
    // Find the last sentence boundary
    const match = text.match(/(?:[.!?]\s+|\n)([^\n.!?]{0,300})$/);
    if (match) return match[1].trim();
    // No prior sentence end found — the whole text might be one sentence
    return text.slice(-200).trim();
  }

  /**
   * Get up to 3 paragraphs ending at the cursor paragraph.
   */
  _getRecentParagraphs(paragraphs, cursorParaIdx) {
    const start = Math.max(0, cursorParaIdx - 2);
    return paragraphs.slice(start, cursorParaIdx + 1).filter(p => p.length > 10);
  }

  /**
   * Document summary: heading + first substantive paragraph.
   * Capped at 200 chars. Gives the LLM intent/topic context.
   */
  _getDocumentSummary(paragraphs) {
    const meaningful = paragraphs.filter(p => p.length > 30);
    const sample = meaningful.slice(0, 2).join(" ");
    return sample.length > 200 ? sample.slice(0, 200) + "…" : sample;
  }

  /**
   * Tone inference via heuristic keyword + structural analysis.
   * Returns one of: formal | academic | persuasive | casual | narrative
   */
  _inferTone(text) {
    const lower = text.toLowerCase();
    const wordCount = text.split(/\s+/).length;
    const avgSentenceLen = wordCount / Math.max(1, (text.match(/[.!?]/g) || []).length);

    // Academic signals
    const academicSignals = ["therefore", "thus", "furthermore", "however", "methodology",
      "analysis", "hypothesis", "whereas", "albeit", "indeed", "notably", "evidence",
      "demonstrates", "suggests", "research", "study", "findings"];

    // Formal signals
    const formalSignals = ["regarding", "pursuant", "hereby", "aforementioned", "notwithstanding",
      "henceforth", "accordingly", "consequently", "nevertheless"];

    // Persuasive signals
    const persuasiveSignals = ["must", "should", "crucial", "essential", "imperative",
      "undeniably", "clearly", "obviously", "argue", "believe", "position"];

    // Casual signals
    const casualSignals = ["i'm", "you're", "we're", "it's", "don't", "can't", "won't",
      "basically", "actually", "pretty much", "kind of", "sort of", "really"];

    // Narrative signals
    const narrativeSignals = ["then", "suddenly", "walked", "said", "felt", "saw",
      "looked", "turned", "seemed", "realized", "knew", "thought"];

    const score = (signals) =>
      signals.filter(s => lower.includes(s)).length;

    const scores = {
      academic:   score(academicSignals) * 2,
      formal:     score(formalSignals) * 2,
      persuasive: score(persuasiveSignals),
      casual:     score(casualSignals),
      narrative:  score(narrativeSignals),
    };

    // Long sentences bias toward academic/formal
    if (avgSentenceLen > 20) {
      scores.academic   += 2;
      scores.formal     += 1;
    }

    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return top[1] > 0 ? top[0] : "formal";
  }
}
