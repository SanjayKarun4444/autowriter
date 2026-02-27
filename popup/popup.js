/**
 * popup.js — Extension popup controller
 *
 * Manages all interactive behaviour in the popup panel.
 * Clean separation of concerns: storage ↔ UI ↔ events.
 * Never touches the document directly — always via the DOM helpers.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// DOM refs (cached once at boot)
// ═══════════════════════════════════════════════════════════════════════════

const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const refs = {
  enableToggle:  $("enableToggle"),
  statusBadge:   $("statusBadge"),
  statusText:    $("statusBadge").querySelector(".status-badge__text"),
  apiKeyInput:   $("apiKeyInput"),
  saveBtn:       $("saveBtn"),
  eyeBtn:        $("eyeBtn"),
  eyeIcon:       $("eyeIcon"),
  keyBadge:      $("keyBadge"),
  selectTrigger: $("selectTrigger"),
  selectChevron: $("selectChevron"),
  selectDropdown:$("selectDropdown"),
  selectedIcon:  $("selectedIcon"),
  selectedName:  $("selectedName"),
  popupBody:     $("popupBody"),
  toast:         $("toast"),
};

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

const state = {
  provider: "mock",
  apiKey:   "",
  enabled:  true,
  dropdownOpen: false,
  keyVisible:   false,
};

const PROVIDERS_NEEDING_KEY = ["anthropic", "openai"];

const PROVIDER_META = {
  anthropic: { icon: "🟣", name: "Claude (Anthropic)" },
  openai:    { icon: "⚪", name: "GPT-4o mini"        },
  local:     { icon: "💻", name: "Local LLM"          },
  mock:      { icon: "🧪", name: "Demo Mode"          },
};

// ═══════════════════════════════════════════════════════════════════════════
// Initialise — load settings then paint UI
// ═══════════════════════════════════════════════════════════════════════════

chrome.storage.sync.get(
  ["enabled", "apiKey", "provider"],
  (prefs) => {
    state.enabled  = prefs.enabled  !== false;
    state.apiKey   = prefs.apiKey   || "";
    state.provider = prefs.provider || "mock";

    paintToggle();
    paintProvider();
    paintKeyField();
    paintStatus();
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Paint helpers — pure UI updates, no storage side-effects
// ═══════════════════════════════════════════════════════════════════════════

function paintToggle() {
  refs.enableToggle.checked = state.enabled;
  refs.enableToggle
    .closest("[role=switch]")
    .setAttribute("aria-checked", String(state.enabled));
}

function paintProvider() {
  const meta = PROVIDER_META[state.provider] || PROVIDER_META.mock;
  refs.selectedIcon.textContent = meta.icon;
  refs.selectedName.textContent = meta.name;

  // Update checkmarks in dropdown
  $$(".custom-select__option").forEach(opt => {
    opt.classList.toggle("is-selected", opt.dataset.value === state.provider);
  });

  // Disable API key field for providers that don't need it
  const needsKey = PROVIDERS_NEEDING_KEY.includes(state.provider);
  refs.apiKeyInput.disabled = !needsKey;
  refs.apiKeyInput.placeholder = needsKey
    ? "Paste your API key…"
    : "No key required for this provider";
}

function paintKeyField() {
  if (state.apiKey) {
    // Show masked key
    refs.apiKeyInput.value = "••••••••••••••••";
    refs.keyBadge.style.display = "inline-flex";
    refs.apiKeyInput.classList.add("is-valid");
  } else {
    refs.apiKeyInput.value = "";
    refs.keyBadge.style.display = "none";
    refs.apiKeyInput.classList.remove("is-valid");
  }
  paintSaveBtn();
}

function paintSaveBtn() {
  const raw = refs.apiKeyInput.value.trim();
  const isMasked = raw === "••••••••••••••••";
  const needsKey = PROVIDERS_NEEDING_KEY.includes(state.provider);
  refs.saveBtn.disabled = !needsKey || !raw || isMasked;
}

function paintStatus() {
  const badge = refs.statusBadge;
  const text  = refs.statusText;

  badge.className = "status-badge";

  if (!state.enabled) {
    badge.classList.add("status-badge--disconnected");
    text.textContent = "Paused";
    return;
  }

  const needsKey = PROVIDERS_NEEDING_KEY.includes(state.provider);
  if (needsKey && !state.apiKey) {
    badge.classList.add("status-badge--disconnected");
    text.textContent = "No key";
  } else {
    badge.classList.add("status-badge--connected");
    text.textContent = "Active";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Event: Master toggle
// ═══════════════════════════════════════════════════════════════════════════

refs.enableToggle.addEventListener("change", () => {
  state.enabled = refs.enableToggle.checked;
  chrome.storage.sync.set({ enabled: state.enabled });
  paintToggle();
  paintStatus();
  broadcastToDocs({ type: "SET_ENABLED", enabled: state.enabled });
  showToast(state.enabled ? "Autocomplete enabled" : "Autocomplete paused");
});

// ═══════════════════════════════════════════════════════════════════════════
// Event: Custom model selector
// ═══════════════════════════════════════════════════════════════════════════

refs.selectTrigger.addEventListener("click", toggleDropdown);

refs.selectTrigger.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleDropdown();
  }
  if (e.key === "Escape" && state.dropdownOpen) {
    closeDropdown();
  }
});

function toggleDropdown() {
  state.dropdownOpen ? closeDropdown() : openDropdown();
}

function openDropdown() {
  state.dropdownOpen = true;
  refs.selectDropdown.style.display = "block";
  refs.selectTrigger.classList.add("is-open");
  refs.selectChevron.classList.add("is-open");
  refs.selectTrigger.setAttribute("aria-expanded", "true");
}

function closeDropdown() {
  state.dropdownOpen = false;
  refs.selectDropdown.style.display = "none";
  refs.selectTrigger.classList.remove("is-open");
  refs.selectChevron.classList.remove("is-open");
  refs.selectTrigger.setAttribute("aria-expanded", "false");
}

$$(".custom-select__option").forEach(opt => {
  opt.addEventListener("click", () => {
    state.provider = opt.dataset.value;
    chrome.storage.sync.set({ provider: state.provider });
    closeDropdown();
    paintProvider();
    paintKeyField();
    paintStatus();
  });

  opt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      opt.click();
    }
  });
});

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  if (state.dropdownOpen && !$("modelSelect").contains(e.target)) {
    closeDropdown();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Event: API Key input + save
// ═══════════════════════════════════════════════════════════════════════════

refs.apiKeyInput.addEventListener("input", () => {
  refs.apiKeyInput.classList.remove("is-valid", "is-error");
  refs.keyBadge.style.display = "none";
  paintSaveBtn();
});

refs.apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") refs.saveBtn.click();
});

refs.saveBtn.addEventListener("click", () => {
  const raw = refs.apiKeyInput.value.trim();
  if (!raw || raw === "••••••••••••••••") return;

  // Quick format validation (heuristic, not authoritative)
  let isValidFormat = true;
  if (state.provider === "openai"    && !raw.startsWith("sk-"))    isValidFormat = false;
  if (state.provider === "anthropic" && !raw.startsWith("sk-ant")) isValidFormat = false;

  if (!isValidFormat) {
    refs.apiKeyInput.classList.add("is-error");
    showToast("⚠️ Key format looks off — double-check it");
    return;
  }

  state.apiKey = raw;
  chrome.storage.sync.set({ apiKey: raw });

  refs.apiKeyInput.classList.remove("is-error");
  refs.apiKeyInput.classList.add("is-valid");
  refs.saveBtn.classList.add("is-saved");
  refs.saveBtn.textContent = "Saved ✓";
  refs.keyBadge.style.display = "inline-flex";

  setTimeout(() => {
    refs.saveBtn.classList.remove("is-saved");
    refs.saveBtn.textContent = "Save";
    refs.apiKeyInput.value = "••••••••••••••••";
    refs.saveBtn.disabled = true;
  }, 1800);

  paintStatus();
  showToast("API key saved");
});

// ── Eye button (show/hide key) ────────────────────────────────────────────

refs.eyeBtn.addEventListener("click", () => {
  state.keyVisible = !state.keyVisible;
  refs.apiKeyInput.type = state.keyVisible ? "text" : "password";
  refs.eyeIcon.innerHTML = state.keyVisible
    ? `<path d="M1 7C1 7 3.5 3 7 3C10.5 3 13 7 13 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
       <path d="M2 12L12 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`
    : `<path d="M1 7C1 7 3.5 3 7 3C10.5 3 13 7 13 7C13 7 10.5 11 7 11C3.5 11 1 7 1 7Z"
             stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
       <circle cx="7" cy="7" r="1.5" stroke="currentColor" stroke-width="1.3"/>`;
});

// ═══════════════════════════════════════════════════════════════════════════
// Footer link handlers
// ═══════════════════════════════════════════════════════════════════════════

$("docsLink").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://github.com/typeahead-ai/docs" });
});

$("feedbackLink").addEventListener("click", () => {
  chrome.tabs.create({ url: "mailto:feedback@typeahead.ai" });
});

// ═══════════════════════════════════════════════════════════════════════════
// Toast utility
// ═══════════════════════════════════════════════════════════════════════════

let toastTimer = null;

function showToast(msg) {
  const el = refs.toast;
  el.textContent = msg;
  el.classList.add("is-visible");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("is-visible");
  }, 2200);
}

// ═══════════════════════════════════════════════════════════════════════════
// Broadcast to open Docs tabs
// ═══════════════════════════════════════════════════════════════════════════

function broadcastToDocs(message) {
  chrome.tabs.query({ url: "https://docs.google.com/document/*" }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}
