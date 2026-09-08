/**
 * storage.js
 * シナリオ(音声Blob + 書き起こし + 模範応答)は IndexedDB に、
 * お気に入りエフェクトプリセットは localStorage に保存する。
 */

const DB_NAME = 'jasdf-rt-trainer';
const DB_VERSION = 1;
const STORE_SCENARIOS = 'scenarios';
const LS_PRESETS_KEY = 'jasdf-rt-trainer.presets';
const MAX_PRESETS = 3;

class Storage {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SCENARIOS)) {
          db.createObjectStore(STORE_SCENARIOS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async saveScenario(scenario) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_SCENARIOS, 'readwrite');
      tx.objectStore(STORE_SCENARIOS).put(scenario);
      tx.oncomplete = () => resolve(scenario);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllScenarios() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_SCENARIOS, 'readonly');
      const req = tx.objectStore(STORE_SCENARIOS).getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
      req.onerror = () => reject(req.error);
    });
  }

  async getScenario(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_SCENARIOS, 'readonly');
      const req = tx.objectStore(STORE_SCENARIOS).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteScenario(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_SCENARIOS, 'readwrite');
      tx.objectStore(STORE_SCENARIOS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Presets (localStorage) ----
  getPresets() {
    try {
      const raw = localStorage.getItem(LS_PRESETS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  savePreset(preset) {
    const presets = this.getPresets();
    presets.push(preset);
    while (presets.length > MAX_PRESETS) presets.shift();
    localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(presets));
    return presets;
  }

  deletePreset(id) {
    const presets = this.getPresets().filter(p => p.id !== id);
    localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(presets));
    return presets;
  }
}

const storage = new Storage();
