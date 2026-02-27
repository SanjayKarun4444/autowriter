/**
 * apiClient.js — Sends structured completion requests to the background worker.
 *
 * Context object now carries:
 *   { systemPrompt: string, userPrompt: string }
 * rather than a raw context string, so the background worker can pass them
 * to the LLM as separate system/user turns.
 */
export function requestCompletion(context) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "GET_COMPLETION", context },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response) return reject(new Error("No response"));
        if (response.type === "COMPLETION_ERROR") {
          return reject(new Error(response.error || "Unknown error"));
        }
        if (response.type === "COMPLETION_RESULT") {
          return resolve(response.text || "");
        }
        reject(new Error("Unexpected response type: " + response.type));
      }
    );
  });
}
