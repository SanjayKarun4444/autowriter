/**
 * PromptEngine.js — Structured prompt template system
 *
 * WHY THE OLD PROMPTS WERE BAD:
 *   1. No document intent — model didn't know the topic
 *   2. No active sentence boundary — model restarted ideas instead of continuing
 *   3. No tone constraint — defaulted to corporate/AI register
 *   4. No negative examples — model used forbidden phrases freely
 *   5. Too vague: "match tone" is not actionable without tone label
 *
 * THIS SYSTEM FIXES THAT BY:
 *   1. Providing structured context (document summary, recent paragraphs, active sentence)
 *   2. Labeling the tone explicitly so the model has a clear target
 *   3. Listing banned phrases and patterns explicitly
 *   4. Constraining output format precisely (no prefix, no repetition)
 *   5. Framing the task as "complete this sentence" not "write something"
 */

export class PromptEngine {

  /**
   * Build a system prompt for the given tone.
   * @param {string} tone — formal | academic | persuasive | casual | narrative
   */
  buildSystemPrompt(tone) {
    const toneGuidance = this._getToneGuidance(tone);

    return `You are an expert writing assistant embedded in a text editor. Your only job is to complete the user's current sentence naturally and seamlessly.

WRITING STYLE TARGET: ${toneGuidance}

STRICT OUTPUT RULES:
- Return ONLY the completion text — nothing else
- Do NOT repeat any text that already exists
- Do NOT add a preamble, explanation, or quotation marks
- Continue EXACTLY where the sentence fragment ends
- Match the author's vocabulary, sentence rhythm, and complexity precisely
- Maximum 1–2 sentences. Stop at a natural pause point.
- End with a period, comma, or naturally — never mid-word

FORBIDDEN PATTERNS (never use these):
- "In conclusion", "Overall", "In summary", "To summarize"
- "It is worth noting", "It should be noted", "It is important to"
- "Furthermore", "Moreover", "Additionally" as sentence openers
- "This is a complex issue", "There are many factors"
- Passive voice constructions unless the existing text uses them
- Generic academic hedging: "may", "might", "could potentially"
- AI-sounding phrases: "certainly", "absolutely", "of course", "indeed"
- Restating what was just said in different words

IF YOU CANNOT GENERATE A NATURAL, HIGH-QUALITY CONTINUATION: return an empty string. Never produce filler.`;
  }

  /**
   * Build the user-turn prompt containing the structured context.
   * @param {object} ctx — from ContextManager.extract()
   */
  buildUserPrompt(ctx) {
    const { activeSentence, recentParagraphs, documentSummary } = ctx;

    const parts = [];

    if (documentSummary && documentSummary.length > 20) {
      parts.push(`DOCUMENT CONTEXT:\n${documentSummary}`);
    }

    if (recentParagraphs && recentParagraphs.length > 1) {
      // Include only paragraphs that aren't the active one
      const history = recentParagraphs.slice(0, -1).join("\n\n");
      if (history.trim()) {
        parts.push(`RECENT PARAGRAPHS:\n${history}`);
      }
    }

    parts.push(`COMPLETE THIS SENTENCE (do not repeat it, only add what comes next):\n${activeSentence}`);

    return parts.join("\n\n---\n\n");
  }

  /**
   * Tone-specific writing guidance injected into system prompt.
   */
  _getToneGuidance(tone) {
    const guidance = {
      academic: "Academic/scholarly prose. Use precise terminology, measured hedging where appropriate (but not excessive), and complex but clear sentence structure. Avoid contractions.",
      formal: "Formal professional prose. Clear, authoritative, no contractions, structured argumentation. Vocabulary should be elevated but not obscure.",
      persuasive: "Persuasive writing. Active voice, confident assertions, strong verbs. Drive toward the argument's conclusion naturally.",
      casual: "Conversational, natural voice. Contractions are fine. Short-to-medium sentences. Sound like a thoughtful person talking, not a document.",
      narrative: "Narrative/storytelling prose. Vivid, sensory detail. Vary sentence rhythm. Move the story or description forward with momentum.",
    };
    return guidance[tone] || guidance.formal;
  }
}
