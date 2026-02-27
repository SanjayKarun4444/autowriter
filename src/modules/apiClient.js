/**
 * apiClient.js — Sends completion requests to background service worker.
 * Returns a promise. Stale responses are filtered by requestId in content.js.
 */
export function requestCompletion(context, requestId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "GET_COMPLETION", context, requestId },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response) {
          return reject(new Error("No response"));
        }
        if (response.type === "COMPLETION_ERROR") {
          return reject(new Error(response.error || "Unknown error"));
        }
        if (response.type === "COMPLETION_RESULT") {
          return resolve(response.text || "");
        }
        reject(new Error("Unexpected response: " + response.type));
      }
    );
  });
}
