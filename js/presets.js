// presets.js
// お気に入り（ノイズ設定プリセット）の永続化。ブラウザの localStorage に保存する。

const STORAGE_KEY = 'atc-trainer:favorites:v1';
const SLOT_COUNT = 3;

/** @returns {Array<{name:string, values:import('./audioEngine.js').NoiseSettings}|null>} */
export function loadFavorites() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedDefaults();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedDefaults();
    const slots = new Array(SLOT_COUNT).fill(null);
    for (let i = 0; i < SLOT_COUNT; i++) slots[i] = parsed[i] ?? null;
    return slots;
  } catch {
    return seedDefaults();
  }
}

export function saveFavorites(slots) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
}

function seedDefaults() {
  const slots = [
    {
      name: '軽度：無線越し',
      values: { mask: 0, radio: 35, wind: 10, accent: 0, dropout: 5 },
    },
    {
      name: '中度：マスク＋風切り',
      values: { mask: 45, radio: 40, wind: 40, accent: 20, dropout: 15 },
    },
    {
      name: '重度：実践想定',
      values: { mask: 55, radio: 65, wind: 55, accent: 45, dropout: 40 },
    },
  ];
  saveFavorites(slots);
  return slots;
}
