// /**
//  * textExtractor.js — Reads context from Google Docs' rendered DOM
//  *
//  * See the architecture note in content.js for the full explanation of
//  * why Docs DOM is complex. This module handles all DOM reading.
//  */

// /**
//  * Extracts the last 1-3 sentences before the cursor.
//  * Returns null if cursor cannot be located or text is too short.
//  * @returns {string|null}
//  */
// export function extractContext() {
//   const cursor = document.querySelector(".kix-cursor");
//   if (!cursor) return null;

//   const cursorRect = cursor.getBoundingClientRect();
//   const paragraphs = Array.from(
//     document.querySelectorAll(".kix-paragraphrenderer")
//   );

//   if (!paragraphs.length) return _fallbackExtract();

//   // Find which paragraph vertically contains the cursor
//   let cursorParaIdx = paragraphs.length - 1; // default to last
//   for (let i = 0; i < paragraphs.length; i++) {
//     const r = paragraphs[i].getBoundingClientRect();
//     if (cursorRect.top >= r.top - 4 && cursorRect.top <= r.bottom + 4) {
//       cursorParaIdx = i;
//       break;
//     }
//   }

//   // Collect up to 3 paragraphs ending at cursor paragraph
//   const start  = Math.max(0, cursorParaIdx - 2);
//   const slice  = paragraphs.slice(start, cursorParaIdx + 1);

//   let text = "";
//   slice.forEach((para, i) => {
//     const isLast = (i === slice.length - 1);
//     text += isLast
//       ? _textBeforeCursor(para, cursorRect.left)
//       : _fullText(para) + " ";
//   });

//   return _trimToContext(text.trim());
// }

// /** Extract all visible text from a paragraph renderer */
// function _fullText(para) {
//   const blocks = para.querySelectorAll(".kix-lineview-text-block");
//   if (blocks.length) {
//     return Array.from(blocks).map(b => b.textContent).join("").replace(/\u00A0/g, " ");
//   }
//   return para.textContent.replace(/\u00A0/g, " ");
// }

// /**
//  * Extract text from a paragraph that sits to the LEFT of cursorX.
//  * We walk span elements and include those whose right edge is before the cursor.
//  */
// function _textBeforeCursor(para, cursorX) {
//   let result = "";

//   const lines = para.querySelectorAll(".kix-lineview");
//   for (const line of lines) {
//     const lineRect = line.getBoundingClientRect();

//     // Lines above the cursor line — include fully
//     if (lineRect.bottom < cursorX - 80) {
//       result += line.textContent.replace(/\u00A0/g, " ");
//       continue;
//     }

//     // On the cursor line — walk spans
//     const spans = line.querySelectorAll(
//       ".kix-lineview-text-block span, .kix-wordhtmlgenerator-word-node"
//     );

//     if (!spans.length) {
//       result += line.textContent.replace(/\u00A0/g, " ");
//       continue;
//     }

//     for (const span of spans) {
//       const sr = span.getBoundingClientRect();
//       if (sr.right <= cursorX + 2) {
//         result += span.textContent.replace(/\u00A0/g, " ");
//       } else if (sr.left < cursorX) {
//         // Cursor is mid-span; approximate by width ratio
//         const t     = span.textContent.replace(/\u00A0/g, " ");
//         const ratio = (cursorX - sr.left) / (sr.width || 1);
//         result += t.slice(0, Math.round(t.length * ratio));
//         break;
//       }
//     }
//   }
//   return result;
// }

// function _fallbackExtract() {
//   const editor = document.querySelector(".kix-appview-editor");
//   return editor ? _trimToContext(editor.textContent.replace(/\u00A0/g, " ").trim()) : null;
// }

// /**
//  * Trim raw text to the last ~400 chars, ideally starting at a sentence boundary.
//  */
// function _trimToContext(text) {
//   if (!text || text.length < 10) return null;
//   const chunk = text.length > 400 ? text.slice(-400) : text;
//   const sentenceStart = chunk.search(/(?<=[.!?]\s)[A-Z]/);
//   if (sentenceStart > 0 && sentenceStart < chunk.length * 0.6) {
//     return chunk.slice(sentenceStart).trim();
//   }
//   const wordBoundary = chunk.indexOf(" ");
//   return wordBoundary > 0 ? chunk.slice(wordBoundary + 1).trim() : chunk.trim();
// }
