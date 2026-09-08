/**
 * presets.js — persistence for the 3 "favorite" noise-effect presets.
 * Stored in localStorage so a controller's go-to noise combinations
 * (e.g. "cockpit windy + weak signal") survive a page reload.
 */
const PresetStore = (() => {
  const KEY = 'jasdf-rt-trainer.favorites.v1';
  const SLOT_COUNT = 3;

  function _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return Array(SLOT_COUNT).fill(null);
      const parsed = JSON.parse(raw);
      const arr = Array(SLOT_COUNT).fill(null);
      for (let i = 0; i < SLOT_COUNT; i++) arr[i] = parsed[i] || null;
      return arr;
    } catch (e) {
      return Array(SLOT_COUNT).fill(null);
    }
  }

  function _save(slots) {
    try { localStorage.setItem(KEY, JSON.stringify(slots)); } catch (e) { /* storage unavailable */ }
  }

  function getAll() { return _load(); }

  function set(index, name, params) {
    const slots = _load();
    slots[index] = { name, params: { ...params } };
    _save(slots);
    return slots;
  }

  function clear(index) {
    const slots = _load();
    slots[index] = null;
    _save(slots);
    return slots;
  }

  return { SLOT_COUNT, getAll, set, clear };
})();
