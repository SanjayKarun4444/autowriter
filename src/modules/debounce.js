/**
 * debounce.js — Debounce + cancel utility
 */
export function createDebouncer(delay, fn) {
  let timer = null;
  const debounced = (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, delay);
  };
  debounced.cancel = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  return debounced;
}
