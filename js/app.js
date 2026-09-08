/**
 * app.js
 * UI制御: タブ切替、シナリオ管理、エフェクトコントロール、プリセット、トレーニングフロー
 */
(function () {
  const engine = new AudioEngine();
  let currentScenario = null;
  let effectSettings = defaultEffectSettings();
  let rafId = null;
  let timeUpdateId = null;
  let pendingAudioFile = null;

  const el = (id) => document.getElementById(id);

  function toast(msg, kind) {
    const t = el('toast');
    t.textContent = msg;
    t.hidden = false;
    t.className = 'toast show' + (kind ? ' toast-' + kind : '');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => { t.hidden = true; t.className = 'toast'; }, 2600);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // ---------------- TABS ----------------
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        el('panel-' + btn.dataset.tab).classList.add('active');
      });
    });
  }

  // ---------------- EFFECT CONTROLS ----------------
  function renderEffectControls() {
    const wrap = el('effectControls');
    wrap.innerHTML = '';
    EFFECT_DEFS.forEach((def) => {
      const s = effectSettings[def.key];
      const row = document.createElement('div');
      row.className = 'fx-row' + (s.enabled ? ' fx-row-on' : '');
      row.innerHTML = `
        <div class="fx-row-top">
          <label class="fx-toggle">
            <input type="checkbox" data-fx="${def.key}" class="fx-enable" ${s.enabled ? 'checked' : ''}>
            <span class="fx-check"></span>
            <span class="fx-name">${def.label}</span>
          </label>
          <span class="fx-value" id="fxval-${def.key}">${s.intensity}%</span>
        </div>
        <input type="range" min="0" max="100" value="${s.intensity}" class="fx-slider" data-fx="${def.key}" aria-label="${def.label} ${def.unit}">
      `;
      wrap.appendChild(row);
    });

    wrap.querySelectorAll('.fx-enable').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        effectSettings[e.target.dataset.fx].enabled = e.target.checked;
        e.target.closest('.fx-row').classList.toggle('fx-row-on', e.target.checked);
        markNeedsRender();
      });
    });
    wrap.querySelectorAll('.fx-slider').forEach((sl) => {
      sl.addEventListener('input', (e) => {
        const key = e.target.dataset.fx;
        effectSettings[key].intensity = parseInt(e.target.value, 10);
        el('fxval-' + key).textContent = effectSettings[key].intensity + '%';
        markNeedsRender();
      });
    });
  }

  function markNeedsRender() {
    if (currentScenario) el('btnRender').classList.add('needs-render');
  }

  // ---------------- PRESETS ----------------
  function renderPresets() {
    const grid = el('presetGrid');
    const presets = storage.getPresets();
    grid.innerHTML = '';
    if (presets.length === 0) {
      grid.innerHTML = '<p class="hint">まだお気に入りはありません。設定後に保存できます。</p>';
      return;
    }
    presets.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'preset-card';
      const activeFx = EFFECT_DEFS.filter((d) => p.settings[d.key] && p.settings[d.key].enabled).map((d) => d.label);
      card.innerHTML = `
        <button class="preset-apply">
          <span class="preset-name">${escapeHtml(p.name)}</span>
          <span class="preset-tags">${activeFx.length ? activeFx.join(' / ') : 'エフェクトなし'}</span>
        </button>
        <button class="preset-del" title="削除">✕</button>
      `;
      card.querySelector('.preset-apply').addEventListener('click', () => {
        effectSettings = JSON.parse(JSON.stringify(p.settings));
        renderEffectControls();
        markNeedsRender();
        toast(`プリセット「${p.name}」を適用しました`);
      });
      card.querySelector('.preset-del').addEventListener('click', (ev) => {
        ev.stopPropagation();
        storage.deletePreset(p.id);
        renderPresets();
      });
      grid.appendChild(card);
    });
  }

  function initPresetSave() {
    el('btnSavePreset').addEventListener('click', () => {
      const presets = storage.getPresets();
      const name = prompt(
        presets.length >= MAX_PRESETS
          ? `お気に入りは最大${MAX_PRESETS}件までです。名前を入力すると一番古いものと入れ替わります。`
          : 'このお気に入り設定の名前を入力してください',
        `プリセット${presets.length + 1}`
      );
      if (!name) return;
      storage.savePreset({ id: 'p_' + Date.now(), name, settings: JSON.parse(JSON.stringify(effectSettings)) });
      renderPresets();
      toast('お気に入りを保存しました');
    });
  }

  // ---------------- SCENARIO LIBRARY ----------------
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function initFileDrop() {
    const drop = el('fileDrop');
    const input = el('scnAudioFile');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleAudioFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) handleAudioFile(input.files[0]);
    });
  }

  function handleAudioFile(file) {
    pendingAudioFile = file;
    el('fileDropLabel').textContent = `選択中: ${file.name}`;
    const preview = el('scnAudioPreview');
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
  }

  async function initScenarioSave() {
    el('btnSaveScenario').addEventListener('click', async () => {
      const name = el('scnName').value.trim();
      const heard = el('scnHeard').value.trim();
      const reply = el('scnReply').value.trim();
      if (!name || !pendingAudioFile || !heard || !reply) {
        el('scenarioSaveHint').textContent = 'シナリオ名・音声ファイル・書き起こし・模範応答をすべて入力してください。';
        el('scenarioSaveHint').className = 'hint hint-error';
        return;
      }
      const scenario = {
        id: 's_' + Date.now(),
        name,
        heard,
        reply,
        audioType: pendingAudioFile.type || 'audio/mpeg',
        audioBlob: pendingAudioFile,
        createdAt: Date.now(),
      };
      await storage.saveScenario(scenario);
      el('scenarioSaveHint').textContent = `「${name}」を保存しました。`;
      el('scenarioSaveHint').className = 'hint hint-ok';
      el('scnName').value = '';
      el('scnHeard').value = '';
      el('scnReply').value = '';
      el('fileDropLabel').textContent = 'クリックまたはドラッグ＆ドロップで音声ファイルを選択';
      el('scnAudioPreview').hidden = true;
      pendingAudioFile = null;
      await refreshScenarioList();
      await refreshScenarioSelect();
      toast('シナリオを保存しました');
    });
  }

  async function refreshScenarioList() {
    const list = el('scenarioList');
    const scenarios = await storage.getAllScenarios();
    list.innerHTML = '';
    if (scenarios.length === 0) {
      list.innerHTML = '<p class="hint">登録済みシナリオはまだありません。</p>';
      return;
    }
    scenarios.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'scenario-item';
      item.innerHTML = `
        <div class="scenario-item-head">
          <span class="scenario-item-name">${escapeHtml(s.name)}</span>
          <button class="scenario-del" title="削除">✕</button>
        </div>
        <p class="scenario-item-line"><span class="si-tag">HEARD</span>${escapeHtml(s.heard)}</p>
        <p class="scenario-item-line"><span class="si-tag">REPLY</span>${escapeHtml(s.reply)}</p>
      `;
      item.querySelector('.scenario-del').addEventListener('click', async () => {
        if (!confirm(`シナリオ「${s.name}」を削除しますか？`)) return;
        await storage.deleteScenario(s.id);
        await refreshScenarioList();
        await refreshScenarioSelect();
        if (currentScenario && currentScenario.id === s.id) resetTrainingPlayer();
      });
      list.appendChild(item);
    });
  }

  async function refreshScenarioSelect() {
    const select = el('scenarioSelect');
    const prevValue = select.value;
    const scenarios = await storage.getAllScenarios();
    select.innerHTML = '<option value="">-- シナリオを選択 --</option>';
    scenarios.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    });
    if (scenarios.some((s) => s.id === prevValue)) select.value = prevValue;
  }

  // ---------------- TRAINING FLOW ----------------
  function resetTrainingPlayer() {
    currentScenario = null;
    engine.stop();
    stopVisualizer();
    el('scenarioMeta').textContent = 'シナリオ管理タブから音声と書き起こしを登録してください。';
    el('btnRender').disabled = true;
    el('btnPlay').disabled = true;
    el('btnCheck').disabled = true;
    el('btnPlayLabel').textContent = '▶ 再生';
    el('timeNow').textContent = '00:00';
    el('timeTotal').textContent = '00:00';
    el('answerKey').hidden = true;
    setRecIndicator(false);
  }

  function initScenarioSelect() {
    el('scenarioSelect').addEventListener('change', async (e) => {
      const id = e.target.value;
      if (!id) { resetTrainingPlayer(); return; }
      const scenario = await storage.getScenario(id);
      if (!scenario) return;
      currentScenario = scenario;
      const arrayBuffer = await scenario.audioBlob.arrayBuffer();
      try {
        await engine.loadArrayBuffer(arrayBuffer);
      } catch (err) {
        toast('音声のデコードに失敗しました', 'error');
        return;
      }
      el('scenarioMeta').textContent = `「${scenario.name}」を読み込みました。ノイズを設定し「①ノイズ適用」→「▶再生」で訓練を開始します。`;
      el('btnRender').disabled = false;
      el('btnRender').classList.add('needs-render');
      el('btnPlay').disabled = true;
      el('btnCheck').disabled = false;
      el('timeTotal').textContent = fmtTime(engine.duration);
      el('timeNow').textContent = '00:00';
      el('answerKey').hidden = true;
      el('answerHeard').value = '';
      el('answerReply').value = '';
    });
  }

  function initRenderButton() {
    el('btnRender').addEventListener('click', async () => {
      if (!currentScenario) return;
      const btn = el('btnRender');
      const prevText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>処理中...</span>';
      try {
        await engine.render(effectSettings);
        btn.classList.remove('needs-render');
        el('btnPlay').disabled = false;
        toast('ノイズエフェクトを適用しました');
      } catch (err) {
        console.error(err);
        toast('エフェクト適用に失敗しました', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = prevText;
      }
    });
  }

  function setRecIndicator(on) {
    el('recIndicator').classList.toggle('rec-live', on);
  }

  function initPlayButton() {
    el('btnPlay').addEventListener('click', () => {
      if (engine.isPlaying) {
        engine.stop();
        stopVisualizer();
        el('btnPlayLabel').textContent = '▶ 再生';
        setRecIndicator(false);
        return;
      }
      engine.play(() => {
        stopVisualizer();
        el('btnPlayLabel').textContent = '▶ 再生';
        el('timeNow').textContent = fmtTime(engine.duration);
        setRecIndicator(false);
      });
      el('btnPlayLabel').textContent = '■ 停止';
      setRecIndicator(true);
      startVisualizer();
      startTimeUpdate();
    });
  }

  function startTimeUpdate() {
    clearInterval(timeUpdateId);
    timeUpdateId = setInterval(() => {
      if (!engine.isPlaying) { clearInterval(timeUpdateId); return; }
      el('timeNow').textContent = fmtTime(Math.min(engine.currentTime, engine.duration));
    }, 200);
  }

  // ---------------- SCOPE VISUALIZER ----------------
  function startVisualizer() {
    const canvas = el('scopeCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    function draw() {
      if (!engine.isPlaying || !engine.analyser) { rafId = null; return; }
      const analyser = engine.analyser;
      const bufferLength = analyser.frequencyBinCount;
      const data = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(data);

      ctx.clearRect(0, 0, W, H);
      const barCount = 48;
      const step = Math.floor(bufferLength / barCount);
      const barWidth = W / barCount;
      for (let i = 0; i < barCount; i++) {
        const v = data[i * step] / 255;
        const barH = Math.max(2, v * H);
        const x = i * barWidth;
        const y = H - barH;
        const grad = ctx.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, '#1fd6a8');
        grad.addColorStop(0.6, '#ffb300');
        grad.addColorStop(1, '#ff5d5d');
        ctx.fillStyle = grad;
        ctx.fillRect(x + 1, y, barWidth - 2, barH);
      }
      rafId = requestAnimationFrame(draw);
    }
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }

  function stopVisualizer() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    const canvas = el('scopeCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ---------------- ANSWER CHECK ----------------
  function initAnswerCheck() {
    el('btnCheck').addEventListener('click', () => {
      if (!currentScenario) return;
      el('keyHeard').textContent = currentScenario.heard;
      el('keyReply').textContent = currentScenario.reply;
      el('answerKey').hidden = false;
      el('answerKey').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    el('btnReset').addEventListener('click', () => {
      el('answerHeard').value = '';
      el('answerReply').value = '';
      el('answerKey').hidden = true;
    });
    document.querySelectorAll('.rate-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        toast(btn.dataset.rate === 'good' ? '評価: 聴取できた ◎' : '評価: 聴取できなかった。もう一度挑戦しましょう');
      });
    });
  }

  // ---------------- ENGINE STATUS ----------------
  function initEngineStatus() {
    const dot = el('engineStatusDot');
    const text = el('engineStatusText');
    document.body.addEventListener('click', () => {
      if (engine.ctx && engine.ctx.state === 'running') {
        dot.classList.add('status-live');
        text.textContent = 'AUDIO ENGINE ONLINE';
      }
    }, { once: true, capture: true });
  }

  // ---------------- INIT ----------------
  async function init() {
    initTabs();
    renderEffectControls();
    renderPresets();
    initPresetSave();
    initFileDrop();
    initScenarioSelect();
    initRenderButton();
    initPlayButton();
    initAnswerCheck();
    initEngineStatus();
    await initScenarioSave();
    await refreshScenarioList();
    await refreshScenarioSelect();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
