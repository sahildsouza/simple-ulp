/**
 * Copied Memory Manager — persists clicked/copied items in localStorage
 * so users can track what they have already processed across searches/sessions.
 */

const CopiedMemory = (() => {
  const STORAGE_KEY = 'ulp_copied_items_v1';
  let copiedSet = new Set();
  const listeners = [];

  // Load from localStorage on initialization
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        copiedSet = new Set(arr);
      }
    }
  } catch (_) {}

  /**
   * Save items back to localStorage (capped at 5,000 to prevent quota issues)
   */
  function persist() {
    try {
      const arr = Array.from(copiedSet).slice(-5000);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch (_) {}
    notify();
  }

  /**
   * Mark an item as copied
   * @param {string} item - The string to remember (email, username, password, or combo)
   */
  function add(item) {
    if (!item || typeof item !== 'string') return;
    copiedSet.add(item);
    persist();
  }

  /**
   * Check if an item has already been clicked/copied
   * @param {string} item
   * @returns {boolean}
   */
  function has(item) {
    if (!item) return false;
    return copiedSet.has(item);
  }

  /**
   * Clear all copied memory
   */
  function clear() {
    copiedSet.clear();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    notify();
  }

  /**
   * Get total number of remembered items
   */
  function count() {
    return copiedSet.size;
  }

  /**
   * Subscribe to memory updates
   */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function notify() {
    listeners.forEach(fn => fn(copiedSet.size));
  }

  return { add, has, clear, count, onChange };
})();
