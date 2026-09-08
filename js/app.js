/**
 * app.js — UI wiring for the R/T listening trainer.
 * Ties together the clip library, the noise-effect console, playback,
 * and the listen→answer→self-score training flow.
 */
(() => {
  'use strict';

  const EFFECTS = [
    { key: 'mask',    ja: 'マスク籠り',           en: 'MASK MUFFLE' },
    { key: 'radio',   ja: '無線ノイズ',           en: 'RADIO NOISE' },
    { key: 'wind',    ja: '風切り音',             en: 'WIND NOISE' },
    { key: 'accent',  ja: '英語の訛り（簡易再現）', en: 'ACCENT (SIMULATED)' },
    { key: 'dropout', ja: '通信不良の音声途切れ', en: 'COMMS DROPOUT' },
  ];

  const engine = new AudioEngine.Engine();

  /** @type {{id:string,name:string,buffer:AudioBuffer,duration:number,transcript:string,response:string}[]} */
  const clips = [];
  let activeClipId = null;
  let isPlaying = false;
  let lastPlayedParams = null;
  let currentLogEntry = null;

  const params = { mask: 0, radio: 0, wind: 0, accent: 0, dropout: 0 };

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const el = {
    clock: $('clock'),
    ctxStatus: $('ctxStatus'),
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    uploadBtn: $('uploadBtn'),
    clipList: $('clipList'),
    answerKeyBox: $('answerKeyBox'),
    keyTranscript: $('keyTranscript'),
    keyResponse: $('keyResponse'),
    saveKeyBtn: $('saveKeyBtn'),
    npName: $('npName'),
    playBtn: $('playBtn'),
    progressFill: $('progressFill'),
    timeCur: $('timeCur'),
    timeDur: $('timeDur'),
    revealFlow: $('revealFlow'),
    myTranscript: $('myTranscript'),
    myResponse: $('myResponse'),
    checkBtn: $('checkBtn'),
    replayBtn: $('replayBtn'),
    modelAnswer: $('modelAnswer'),
    maTranscript: $('maTranscript'),
    maResponse: $('maResponse'),
    sessionCount: $('sessionCount'),
    sessionLogList: $('sessionLogList'),
    favSlots: $('favSlots'),
    sliderRack: $('sliderRack'),
    resetSlidersBtn: $('resetSlidersBtn'),
    toast: $('toast'),
  };

  // ---- utilities ----
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
  }

  function setStatus(state) {
    el.ctxStatus.dataset.state = state;
  }

  function activeClip() {
    return clips.find((c) => c.id === activeClipId) || null;
  }

  // ---- clock (UTC / Zulu, as used in aviation R/T) ----
  function tickClock() {
    const d = new Date();
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    el.clock.textContent = `${h}:${m}:${s}Z`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  // ---- slider rack ----
  function buildSliderRack() {
    el.sliderRack.innerHTML = '';
    for (const eff of EFFECTS) {
      const row = document.createElement('div');
      row.className = 'slider-row';
      row.innerHTML = `
        <div class="slider-head">
          <span class="sl-name">${eff.ja}<span class="en">${eff.en}</span></span>
          <span class="sl-val" id="val-${eff.key}">0%</span>
        </div>
        <div class="gauge">
          <div class="gauge-fill" id="fill-${eff.key}" style="width:0%"></div>
          <div class="gauge-ticks">${'<span></span>'.repeat(10)}</div>
          <input type="range" id="range-${eff.key}" min="0" max="100" value="0" step="1"
                 aria-label="${eff.ja}">
        </div>`;
      el.sliderRack.appendChild(row);
    }
    for (const eff of EFFECTS) {
      const range = $(`range-${eff.key}`);
      range.addEventListener('input', () => setParam(eff.key, Number(range.value)));
    }
  }

  function setParam(key, value) {
    params[key] = value;
    $(`range-${key}`).value = String(value);
    $(`val-${key}`).textContent = `${value}%`;
    $(`fill-${key}`).style.width = `${value}%`;
  }

  function setAllParams(newParams) {
    for (const eff of EFFECTS) setParam(eff.key, Number(newParams[eff.key] || 0));
  }

  el.resetSlidersBtn.addEventListener('click', () => {
    setAllParams({ mask: 0, radio: 0, wind: 0, accent: 0, dropout: 0 });
    toast('エフェクトを全てリセットしました');
  });

  // ---- favorites ----
  function renderFavSlots() {
    const slots = PresetStore.getAll();
    el.favSlots.innerHTML = '';
    slots.forEach((slot, i) => {
      const div = document.createElement('div');
      div.className = 'fav-slot' + (slot ? ' filled' : '');
      div.innerHTML = slot
        ? `<button class="fav-clear" title="削除">×</button>
           <button class="fav-save" title="現在の設定で上書き">💾</button>
           SLOT ${i + 1}<span class="fav-name">${escapeHtml(slot.name)}</span>`
        : `<button class="fav-save" title="現在の設定を保存">＋</button>
           SLOT ${i + 1}<span class="fav-name">未登録</span>`;

      div.addEventListener('click', (e) => {
        if (e.target.closest('.fav-save') || e.target.closest('.fav-clear')) return;
        if (!slot) { toast('このスロットには保存されたお気に入りがありません'); return; }
        setAllParams(slot.params);
        toast(`お気に入り「${slot.name}」を読み込みました`);
      });

      const saveBtn = div.querySelector('.fav-save');
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = window.prompt('このお気に入りの名前を入力してください', slot ? slot.name : `プリセット${i + 1}`);
        if (name === null) return;
        const trimmed = name.trim() || `プリセット${i + 1}`;
        PresetStore.set(i, trimmed, params);
        renderFavSlots();
        toast(`現在のエフェクト設定を「${trimmed}」として保存しました`);
      });

      const clearBtn = div.querySelector('.fav-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!window.confirm(`「${slot.name}」を削除しますか？`)) return;
          PresetStore.clear(i);
          renderFavSlots();
        });
      }

      el.favSlots.appendChild(div);
    });
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ---- clip library ----
  function renderClipList() {
    el.clipList.innerHTML = '';
    if (clips.length === 0) {
      el.clipList.innerHTML = '<li class="clip-empty">音声が登録されていません</li>';
      return;
    }
    for (const clip of clips) {
      const li = document.createElement('li');
      li.className = 'clip-item' + (clip.id === activeClipId ? ' active' : '');
      const hasKey = clip.transcript || clip.response;
      li.innerHTML = `
        <span class="clip-name" title="${escapeHtml(clip.name)}">${escapeHtml(clip.name)}</span>
        <span class="clip-tag">${fmtTime(clip.duration)}${hasKey ? ' ✓' : ''}</span>
        <button class="clip-del" title="削除">✕</button>`;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.clip-del')) return;
        selectClip(clip.id);
      });
      li.querySelector('.clip-del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!window.confirm(`「${clip.name}」をライブラリから削除しますか？`)) return;
        removeClip(clip.id);
      });
      el.clipList.appendChild(li);
    }
  }

  function selectClip(id) {
    if (isPlaying) engine.stop();
    isPlaying = false;
    activeClipId = id;
    const clip = activeClip();
    el.npName.textContent = clip ? clip.name : '― 未選択 ―';
    el.playBtn.disabled = !clip;
    el.playBtn.classList.remove('playing');
    el.progressFill.style.width = '0%';
    el.timeCur.textContent = '0:00';
    el.timeDur.textContent = clip ? fmtTime(clip.duration) : '0:00';
    el.revealFlow.hidden = true;
    el.modelAnswer.hidden = true;
    el.myTranscript.value = '';
    el.myResponse.value = '';
    currentLogEntry = null;
    if (clip) {
      el.answerKeyBox.hidden = false;
      el.keyTranscript.value = clip.transcript || '';
      el.keyResponse.value = clip.response || '';
    } else {
      el.answerKeyBox.hidden = true;
    }
    renderClipList();
    setStatus(clip ? 'ready' : 'idle');
  }

  function removeClip(id) {
    const idx = clips.findIndex((c) => c.id === id);
    if (idx >= 0) clips.splice(idx, 1);
    if (activeClipId === id) {
      selectClip(clips.length ? clips[0].id : null);
    } else {
      renderClipList();
    }
  }

  el.saveKeyBtn.addEventListener('click', () => {
    const clip = activeClip();
    if (!clip) return;
    clip.transcript = el.keyTranscript.value.trim();
    clip.response = el.keyResponse.value.trim();
    renderClipList();
    toast('模範解答を登録しました');
  });

  // ---- file upload ----
  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(f.name));
    if (files.length === 0) { toast('音声ファイルを選択してください'); return; }
    for (const file of files) {
      try {
        const buffer = await engine.decodeFile(file);
        const clip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          buffer,
          duration: buffer.duration,
          transcript: '',
          response: '',
        };
        clips.push(clip);
        if (!activeClipId) selectClip(clip.id);
        else renderClipList();
        setStatus('ready');
      } catch (err) {
        console.error(err);
        toast(`読み込み失敗: ${file.name}`);
      }
    }
  }

  el.uploadBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    el.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    el.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropZone.classList.remove('dragover');
    });
  });
  el.dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // ---- playback ----
  function startPlayback() {
    const clip = activeClip();
    if (!clip) return;
    engine.ensureContext();
    isPlaying = true;
    lastPlayedParams = { ...params };
    el.playBtn.classList.add('playing');
    el.playBtn.querySelector('.ptt-icon').textContent = '■';
    el.playBtn.querySelector('.ptt-text').textContent = 'STOP';
    el.revealFlow.hidden = true;
    el.modelAnswer.hidden = true;
    currentLogEntry = null;
    setStatus('playing');

    engine.play(clip.buffer, lastPlayedParams, {
      onProgress(cur, dur) {
        el.progressFill.style.width = `${dur ? (cur / dur) * 100 : 0}%`;
        el.timeCur.textContent = fmtTime(cur);
        el.timeDur.textContent = fmtTime(dur);
      },
      onEnded() {
        finishPlayback();
      },
    });
  }

  function finishPlayback() {
    isPlaying = false;
    el.playBtn.classList.remove('playing');
    el.playBtn.querySelector('.ptt-icon').textContent = '▶';
    el.playBtn.querySelector('.ptt-text').textContent = 'PLAY';
    setStatus('ready');
    el.revealFlow.hidden = false;
  }

  el.playBtn.addEventListener('click', () => {
    if (isPlaying) {
      engine.stop();
      finishPlayback();
      el.revealFlow.hidden = true; // manual stop mid-way isn't a completed listen
    } else {
      startPlayback();
    }
  });

  el.replayBtn.addEventListener('click', () => {
    const clip = activeClip();
    if (!clip || !lastPlayedParams) { startPlayback(); return; }
    engine.ensureContext();
    isPlaying = true;
    el.playBtn.classList.add('playing');
    el.playBtn.querySelector('.ptt-icon').textContent = '■';
    el.playBtn.querySelector('.ptt-text').textContent = 'STOP';
    setStatus('playing');
    engine.play(clip.buffer, lastPlayedParams, {
      onProgress(cur, dur) {
        el.progressFill.style.width = `${dur ? (cur / dur) * 100 : 0}%`;
        el.timeCur.textContent = fmtTime(cur);
        el.timeDur.textContent = fmtTime(dur);
      },
      onEnded() { finishPlayback(); },
    });
  });

  // ---- answer / reveal flow ----
  el.checkBtn.addEventListener('click', () => {
    const clip = activeClip();
    if (!clip) return;
    el.maTranscript.textContent = clip.transcript || '（模範解答が未登録です）';
    el.maResponse.textContent = clip.response || '（模範解答が未登録です）';
    el.modelAnswer.hidden = false;
    document.querySelectorAll('.score-btn').forEach((b) => b.classList.remove('active'));
  });

  document.querySelectorAll('.score-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const clip = activeClip();
      if (!clip) return;
      document.querySelectorAll('.score-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const score = btn.dataset.score;
      const scoreLabel = { ok: '◎ 完全に聴取', mid: '△ 部分的', ng: '✕ 聴取不可' }[score];
      const timeStr = new Date().toLocaleTimeString('ja-JP', { hour12: false });

      if (currentLogEntry) {
        currentLogEntry.score = score;
        currentLogEntry.li.className = `log-${score}`;
        currentLogEntry.li.textContent = `[${currentLogEntry.time}] ${clip.name} ― ${scoreLabel}`;
      } else {
        const li = document.createElement('li');
        li.className = `log-${score}`;
        li.textContent = `[${timeStr}] ${clip.name} ― ${scoreLabel}`;
        el.sessionLogList.prepend(li);
        currentLogEntry = { li, time: timeStr, score };
        el.sessionCount.textContent = String(Number(el.sessionCount.textContent) + 1);
      }
    });
  });

  // ---- init ----
  buildSliderRack();
  renderFavSlots();
  renderClipList();
  setStatus('idle');
})();
