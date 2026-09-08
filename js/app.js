// app.js — UI配線・再生制御・訓練パネルのロジック

import { emptySettings, decodeFile, renderProcessedAudio } from './audioEngine.js';
import { loadFavorites, saveFavorites } from './presets.js';

const GAUGE_DEFS = [
  { key: 'mask', code: 'MSK', name: 'マスク籠り', nameEn: 'OXYGEN MASK MUFFLE' },
  { key: 'radio', code: 'RAD', name: '無線ノイズ', nameEn: 'RADIO STATIC / BAND-LIMIT' },
  { key: 'wind', code: 'WND', name: '風切り音', nameEn: 'WIND NOISE' },
  { key: 'accent', code: 'ACC', name: '英語の訛り（簡易再現）', nameEn: 'ACCENT SIMULATION' },
  { key: 'dropout', code: 'DRP', name: '通信不良（音声途切れ）', nameEn: 'SIGNAL DROPOUT' },
];

/** @type {AudioContext|null} */
let audioCtx = null;
let audioBuffer = null;       // 生デコード済みバッファ
let processedBuffer = null;   // レンダリング済み（ノイズ適用後）バッファ
let processedKey = '';        // どの設定でレンダリング済みか判定するキー
let currentSource = null;     // 再生中の AudioBufferSourceNode
let playState = { playing: false, startedAtCtxTime: 0, bufferDuration: 0, rafId: 0 };

const settings = emptySettings();

// ---------------------------------------------------------------------------
// DOM取得
// ---------------------------------------------------------------------------
const el = {
  fileInput: document.getElementById('fileInput'),
  uploadBtn: document.getElementById('uploadBtn'),
  dropZone: document.getElementById('dropZone'),
  fileName: document.getElementById('fileName'),
  waveform: document.getElementById('waveform'),
  playhead: document.getElementById('playhead'),
  playDryBtn: document.getElementById('playDryBtn'),
  playWetBtn: document.getElementById('playWetBtn'),
  stopBtn: document.getElementById('stopBtn'),
  timeCur: document.getElementById('timeCur'),
  timeDur: document.getElementById('timeDur'),
  renderStatus: document.getElementById('renderStatus'),
  gaugeList: document.getElementById('gaugeList'),
  masterMeterFill: document.getElementById('masterMeterFill'),
  masterValue: document.getElementById('masterValue'),
  favoritesList: document.getElementById('favoritesList'),
  engineStatus: document.getElementById('engineStatus'),
  engineStatusText: document.getElementById('engineStatusText'),
  toggleAnswerBtn: document.getElementById('toggleAnswerBtn'),
  trainingPanel: document.querySelector('.panel-training'),
  clearAttemptBtn: document.getElementById('clearAttemptBtn'),
  heardInput: document.getElementById('heardInput'),
  responseInput: document.getElementById('responseInput'),
};

// ---------------------------------------------------------------------------
// ゲージ（ノイズ強度スライダー）
// ---------------------------------------------------------------------------
function buildGauges() {
  el.gaugeList.innerHTML = '';
  for (const def of GAUGE_DEFS) {
    const item = document.createElement('div');
    item.className = 'gauge-item';
    item.innerHTML = `
      <div class="gauge-head">
        <span class="gauge-icon">[${def.code}]</span>
        <span class="gauge-name">${def.name}<span class="gauge-name-en">${def.nameEn}</span></span>
        <span class="gauge-value" data-value-for="${def.key}">0%</span>
      </div>
      <div class="gauge-track-wrap">
        <div class="gauge-fill-bg"></div>
        <input type="range" class="gauge-slider" min="0" max="100" step="1" value="0" data-key="${def.key}">
      </div>
    `;
    el.gaugeList.appendChild(item);
  }

  el.gaugeList.querySelectorAll('.gauge-slider').forEach((slider) => {
    slider.addEventListener('input', () => {
      const key = slider.dataset.key;
      settings[key] = Number(slider.value);
      el.gaugeList.querySelector(`[data-value-for="${key}"]`).textContent = `${settings[key]}%`;
      updateMasterMeter();
      invalidateProcessedCache();
    });
  });
}

function applySettingsToGauges() {
  el.gaugeList.querySelectorAll('.gauge-slider').forEach((slider) => {
    const key = slider.dataset.key;
    slider.value = String(settings[key] ?? 0);
    el.gaugeList.querySelector(`[data-value-for="${key}"]`).textContent = `${settings[key] ?? 0}%`;
  });
  updateMasterMeter();
  invalidateProcessedCache();
}

function updateMasterMeter() {
  const avg = GAUGE_DEFS.reduce((sum, d) => sum + settings[d.key], 0) / GAUGE_DEFS.length;
  el.masterMeterFill.style.width = `${avg}%`;
  el.masterValue.textContent = `${Math.round(avg)}%`;
}

function invalidateProcessedCache() {
  processedKey = '';
  processedBuffer = null;
}

function settingsKey() {
  return GAUGE_DEFS.map((d) => `${d.key}:${settings[d.key]}`).join('|');
}

// ---------------------------------------------------------------------------
// お気に入り（プリセット）
// ---------------------------------------------------------------------------
let favorites = loadFavorites();

function summarizeSettings(values) {
  const parts = GAUGE_DEFS
    .filter((d) => (values[d.key] ?? 0) > 0)
    .map((d) => `${d.code} ${values[d.key]}%`);
  return parts.length ? parts.join(' / ') : '（全ゼロ）';
}

function renderFavorites() {
  el.favoritesList.innerHTML = '';
  favorites.forEach((slot, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'favorite-slot' + (slot ? '' : ' empty');
    wrap.innerHTML = `
      <div class="favorite-head">
        <span class="favorite-num">${idx + 1}</span>
        <input type="text" class="favorite-name" value="${slot ? escapeAttr(slot.name) : ''}" placeholder="未設定スロット">
      </div>
      <p class="favorite-summary">${slot ? summarizeSettings(slot.values) : '現在の設定を保存してください'}</p>
      <div class="favorite-actions">
        <button class="btn btn-load" ${slot ? '' : 'disabled'}>呼び出し</button>
        <button class="btn btn-save">現在値を保存</button>
      </div>
    `;

    wrap.querySelector('.btn-load').addEventListener('click', () => {
      if (!favorites[idx]) return;
      Object.assign(settings, favorites[idx].values);
      applySettingsToGauges();
      flashStatus(`お気に入り ${idx + 1}「${favorites[idx].name}」を適用しました`);
    });

    wrap.querySelector('.btn-save').addEventListener('click', () => {
      const nameInput = wrap.querySelector('.favorite-name');
      const name = nameInput.value.trim() || `プリセット ${idx + 1}`;
      favorites[idx] = { name, values: { ...settings } };
      saveFavorites(favorites);
      renderFavorites();
      flashStatus(`現在の設定をお気に入り ${idx + 1} に保存しました`);
    });

    wrap.querySelector('.favorite-name').addEventListener('change', () => {
      if (!favorites[idx]) return;
      favorites[idx].name = wrap.querySelector('.favorite-name').value.trim() || favorites[idx].name;
      saveFavorites(favorites);
    });

    el.favoritesList.appendChild(wrap);
  });
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// ファイルアップロード & 波形描画
// ---------------------------------------------------------------------------
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

async function handleFile(file) {
  if (!file) return;
  setEngineStatus('busy', 'DECODING...');
  try {
    const ctx = getAudioCtx();
    audioBuffer = await decodeFile(file, ctx);
    invalidateProcessedCache();
    el.fileName.textContent = file.name;
    drawWaveform(audioBuffer);
    el.timeDur.textContent = formatTime(audioBuffer.duration);
    el.timeCur.textContent = formatTime(0);
    el.playDryBtn.disabled = false;
    el.playWetBtn.disabled = false;
    el.stopBtn.disabled = false;
    setEngineStatus('on', 'READY');
  } catch (err) {
    console.error(err);
    setEngineStatus('off', 'DECODE ERROR');
    el.renderStatus.textContent = '音声の読み込みに失敗しました。対応形式のファイルを選択してください。';
  }
}

function drawWaveform(buffer) {
  const canvas = el.waveform;
  const ctx2d = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx2d.clearRect(0, 0, w, h);

  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / w);
  const mid = h / 2;

  ctx2d.strokeStyle = 'rgba(30,58,82,0.6)';
  ctx2d.beginPath();
  ctx2d.moveTo(0, mid);
  ctx2d.lineTo(w, mid);
  ctx2d.stroke();

  ctx2d.fillStyle = '#35d1e0';
  for (let x = 0; x < w; x++) {
    let min = 1.0, max = -1.0;
    const start = x * step;
    for (let i = 0; i < step && start + i < data.length; i++) {
      const v = data[start + i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid + min * mid * 0.9;
    const y2 = mid + max * mid * 0.9;
    ctx2d.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

// ---------------------------------------------------------------------------
// 再生制御
// ---------------------------------------------------------------------------
function stopPlayback() {
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }
  playState.playing = false;
  cancelAnimationFrame(playState.rafId);
  el.playhead.style.left = '0px';
  el.timeCur.textContent = formatTime(0);
}

function playBuffer(buffer) {
  stopPlayback();
  const ctx = getAudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (currentSource === source) {
      playState.playing = false;
      cancelAnimationFrame(playState.rafId);
    }
  };
  source.start(0);
  currentSource = source;
  playState.playing = true;
  playState.startedAtCtxTime = ctx.currentTime;
  playState.bufferDuration = buffer.duration;
  animatePlayhead();
}

function animatePlayhead() {
  const tick = () => {
    if (!playState.playing) return;
    const elapsed = getAudioCtx().currentTime - playState.startedAtCtxTime;
    const clamped = Math.min(elapsed, playState.bufferDuration);
    const ratio = playState.bufferDuration > 0 ? clamped / playState.bufferDuration : 0;
    el.playhead.style.left = `${ratio * el.waveform.clientWidth}px`;
    el.timeCur.textContent = formatTime(clamped);
    if (elapsed < playState.bufferDuration) {
      playState.rafId = requestAnimationFrame(tick);
    } else {
      playState.playing = false;
    }
  };
  playState.rafId = requestAnimationFrame(tick);
}

function formatTime(sec) {
  if (!isFinite(sec)) return '00:00';
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function setEngineStatus(state, text) {
  el.engineStatus.className = `status-dot ${state === 'off' ? '' : state}`;
  el.engineStatusText.textContent = text;
}

function flashStatus(msg) {
  el.renderStatus.textContent = msg;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => { el.renderStatus.textContent = ''; }, 3500);
}

// ---------------------------------------------------------------------------
// イベント配線
// ---------------------------------------------------------------------------
el.uploadBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragover', 'dragenter'].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => { e.preventDefault(); el.dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => { e.preventDefault(); el.dropZone.classList.remove('dragover'); })
);
el.dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

el.playDryBtn.addEventListener('click', () => {
  if (!audioBuffer) return;
  playBuffer(audioBuffer);
});

el.playWetBtn.addEventListener('click', async () => {
  if (!audioBuffer) return;
  const key = settingsKey();
  if (processedBuffer && processedKey === key) {
    playBuffer(processedBuffer);
    return;
  }
  setEngineStatus('busy', 'RENDERING NOISE...');
  el.playWetBtn.disabled = true;
  el.renderStatus.textContent = 'ノイズエフェクトを合成中...';
  try {
    processedBuffer = await renderProcessedAudio(audioBuffer, settings);
    processedKey = key;
    playBuffer(processedBuffer);
    el.renderStatus.textContent = '';
    setEngineStatus('on', 'READY');
  } catch (err) {
    console.error(err);
    el.renderStatus.textContent = 'ノイズ合成に失敗しました。';
    setEngineStatus('off', 'RENDER ERROR');
  } finally {
    el.playWetBtn.disabled = false;
  }
});

el.stopBtn.addEventListener('click', stopPlayback);

el.toggleAnswerBtn.addEventListener('click', () => {
  const revealed = el.trainingPanel.classList.toggle('answers-revealed');
  el.toggleAnswerBtn.textContent = revealed ? '解答を隠す' : '解答を表示';
});

el.clearAttemptBtn.addEventListener('click', () => {
  el.heardInput.value = '';
  el.responseInput.value = '';
  el.heardInput.focus();
});

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
buildGauges();
applySettingsToGauges();
renderFavorites();
setEngineStatus('off', 'AUDIO ENGINE STANDBY — 音声を選択してください');
