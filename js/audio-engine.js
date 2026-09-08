/**
 * audio-engine.js
 * Web Audio API を用いた無線交信ノイズエフェクトエンジン。
 * 各エフェクトは OfflineAudioContext 上でノードグラフを組んでレンダリングする。
 */

const EFFECT_DEFS = [
  { key: 'muffle', label: 'マスク籠り', unit: '籠り度' },
  { key: 'radio',  label: '無線ノイズ', unit: 'ノイズ量' },
  { key: 'wind',   label: '風切り音',   unit: '風量' },
  { key: 'accent', label: '英語訛り',   unit: '訛り度' },
  { key: 'dropout',label: '通信途切れ', unit: '途切れ頻度' },
];

function defaultEffectSettings() {
  const s = {};
  for (const d of EFFECT_DEFS) s[d.key] = { enabled: false, intensity: 30 };
  return s;
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.originalBuffer = null;
    this.processedBuffer = null;
    this.sourceNode = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.isPlaying = false;
    this._analyser = null;
    this.onEnded = null;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.ctx;
  }

  async loadArrayBuffer(arrayBuffer) {
    const ctx = this._ensureCtx();
    const copy = arrayBuffer.slice(0);
    this.originalBuffer = await ctx.decodeAudioData(copy);
    this.processedBuffer = this.originalBuffer;
    return this.originalBuffer;
  }

  get duration() {
    return this.originalBuffer ? this.originalBuffer.duration : 0;
  }

  /** ホワイト/ピンクノイズバッファを生成 */
  _makeNoiseBuffer(ctx, kind, duration, sampleRate) {
    const length = Math.max(1, Math.floor(duration * sampleRate));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    if (kind === 'white') {
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    } else if (kind === 'pink') {
      // Paul Kellet の近似ピンクノイズ生成
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        data[i] = pink * 0.11;
      }
    }
    return buffer;
  }

  _makeDistortionCurve(amount) {
    const k = amount;
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /**
   * 通信途切れエフェクト: レンダリング後のバッファに対して直接サンプル操作。
   * 一定確率でランダム長のドロップアウト区間を作り、その区間をスケルチノイズ+減衰に置換する。
   */
  _applyDropoutToBuffer(buffer, intensity01) {
    if (intensity01 <= 0) return buffer;
    const sr = buffer.sampleRate;
    const totalLen = buffer.length;
    const durationSec = totalLen / sr;

    // 強度に応じてドロップアウト発生回数を決める（1秒あたり最大 ~1.6 回）
    const eventsPerSec = 0.25 + intensity01 * 1.35;
    const numEvents = Math.max(0, Math.round(durationSec * eventsPerSec));

    // 全チャンネル共通のマスク（1.0=通常, 0.0=完全ドロップ）
    const mask = new Float32Array(totalLen).fill(1);
    const minLenSec = 0.04 + intensity01 * 0.02;
    const maxLenSec = 0.12 + intensity01 * 0.35;

    for (let e = 0; e < numEvents; e++) {
      const startSec = Math.random() * Math.max(0.001, durationSec - 0.05);
      const lenSec = minLenSec + Math.random() * (maxLenSec - minLenSec);
      const start = Math.floor(startSec * sr);
      const len = Math.min(totalLen - start, Math.floor(lenSec * sr));
      if (len <= 0) continue;
      const fade = Math.min(len, Math.floor(0.004 * sr)) || 1;
      for (let i = 0; i < len; i++) {
        let g = 0.05; // わずかにスケルチが残る程度まで減衰
        if (i < fade) g = 1 - (1 - g) * (i / fade);
        else if (i > len - fade) g = 1 - (1 - g) * ((len - i) / fade);
        const idx = start + i;
        mask[idx] = Math.min(mask[idx], g);
      }
    }

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < totalLen; i++) {
        // ドロップ区間にはわずかなスケルチ性ノイズを混ぜる
        const g = mask[i];
        if (g < 0.99) {
          const squelch = (Math.random() * 2 - 1) * 0.02 * intensity01;
          data[i] = data[i] * g + squelch * (1 - g);
        }
      }
    }
    return buffer;
  }

  /**
   * settings: { muffle:{enabled,intensity}, radio:{...}, wind:{...}, accent:{...}, dropout:{...} }
   * intensity は 0-100
   */
  async render(settings) {
    if (!this.originalBuffer) throw new Error('音声が読み込まれていません');
    const src = this.originalBuffer;
    const ctx = this._ensureCtx();
    const offline = new OfflineAudioContext(src.numberOfChannels, src.length, src.sampleRate);

    const bufferSource = offline.createBufferSource();
    bufferSource.buffer = src;

    let chainEnd = bufferSource;
    const masterGain = offline.createGain();
    masterGain.gain.value = 1;

    const noiseStarts = [];

    // ---- マスク籠り: ローパスフィルタ ----
    if (settings.muffle && settings.muffle.enabled) {
      const t = settings.muffle.intensity / 100;
      const lp = offline.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 7000 - t * 5700; // 7000Hz -> 1300Hz
      lp.Q.value = 0.7 + t * 1.8;
      chainEnd.connect(lp);
      chainEnd = lp;
    }

    // ---- 英語訛り: フォルマント風ピーキングEQ + 軽いコーラス ----
    if (settings.accent && settings.accent.enabled) {
      const t = settings.accent.intensity / 100;

      const peak1 = offline.createBiquadFilter();
      peak1.type = 'peaking';
      peak1.frequency.value = 900;
      peak1.Q.value = 1.2;
      peak1.gain.value = 6 * t;
      chainEnd.connect(peak1);

      const peak2 = offline.createBiquadFilter();
      peak2.type = 'peaking';
      peak2.frequency.value = 2400;
      peak2.Q.value = 1.0;
      peak2.gain.value = -5 * t;
      peak1.connect(peak2);
      chainEnd = peak2;

      // 軽いコーラス（短時間ディレイ+LFO変調）で声質のゆらぎを演出
      const delay = offline.createDelay();
      delay.delayTime.value = 0.012;
      const lfo = offline.createOscillator();
      lfo.frequency.value = 3.2;
      const lfoGain = offline.createGain();
      lfoGain.gain.value = 0.004 * t;
      lfo.connect(lfoGain);
      lfoGain.connect(delay.delayTime);
      lfo.start(0);

      const chorusMix = offline.createGain();
      chorusMix.gain.value = 0.5 * t;
      const dryMix = offline.createGain();
      dryMix.gain.value = 1;

      chainEnd.connect(delay);
      const merged = offline.createGain();
      delay.connect(chorusMix);
      chorusMix.connect(merged);
      chainEnd.connect(dryMix);
      dryMix.connect(merged);
      chainEnd = merged;
    }

    // ---- 無線ノイズ: バンドパス(通信帯域)+ディストーション+ノイズベッド ----
    if (settings.radio && settings.radio.enabled) {
      const t = settings.radio.intensity / 100;
      const bp = offline.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900;
      bp.Q.value = 0.5 + t * 1.2;
      chainEnd.connect(bp);

      const shaper = offline.createWaveShaper();
      shaper.curve = this._makeDistortionCurve(4 + t * 22);
      shaper.oversample = '2x';
      bp.connect(shaper);
      chainEnd = shaper;

      const noiseBuf = this._makeNoiseBuffer(offline, 'white', src.duration + 0.1, src.sampleRate);
      const noiseSrc = offline.createBufferSource();
      noiseSrc.buffer = noiseBuf;
      const noiseBp = offline.createBiquadFilter();
      noiseBp.type = 'bandpass';
      noiseBp.frequency.value = 2200;
      noiseBp.Q.value = 0.6;
      const noiseGain = offline.createGain();
      noiseGain.gain.value = 0.03 + t * 0.11;
      noiseSrc.connect(noiseBp);
      noiseBp.connect(noiseGain);
      noiseGain.connect(masterGain);
      noiseStarts.push(noiseSrc);
    }

    // ---- 風切り音: ピンクノイズ + LFOで振幅変調 ----
    if (settings.wind && settings.wind.enabled) {
      const t = settings.wind.intensity / 100;
      const windBuf = this._makeNoiseBuffer(offline, 'pink', src.duration + 0.1, src.sampleRate);
      const windSrc = offline.createBufferSource();
      windSrc.buffer = windBuf;

      const windLp = offline.createBiquadFilter();
      windLp.type = 'lowpass';
      windLp.frequency.value = 900;

      const windGain = offline.createGain();
      windGain.gain.value = 0.06 + t * 0.28;

      const lfo = offline.createOscillator();
      lfo.frequency.value = 0.6 + t * 1.5;
      const lfoDepth = offline.createGain();
      lfoDepth.gain.value = (0.06 + t * 0.28) * 0.6;
      const lfoOffset = offline.createConstantSource();
      lfoOffset.offset.value = 0.06 + t * 0.28;

      lfo.connect(lfoDepth);
      lfoDepth.connect(windGain.gain);
      lfoOffset.connect(windGain.gain);
      lfo.start(0);
      lfoOffset.start(0);

      windSrc.connect(windLp);
      windLp.connect(windGain);
      windGain.connect(masterGain);
      noiseStarts.push(windSrc);
    }

    chainEnd.connect(masterGain);
    masterGain.connect(offline.destination);

    bufferSource.start(0);
    for (const n of noiseStarts) n.start(0);

    let rendered = await offline.startRendering();

    // ---- 通信途切れ: レンダリング後のサンプルに直接適用 ----
    if (settings.dropout && settings.dropout.enabled) {
      const t = settings.dropout.intensity / 100;
      rendered = this._applyDropoutToBuffer(rendered, t);
    }

    this.processedBuffer = rendered;
    return rendered;
  }

  resetToOriginal() {
    this.processedBuffer = this.originalBuffer;
  }

  play(onEnded) {
    this.stop();
    const ctx = this._ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = this.processedBuffer || this.originalBuffer;
    if (!buf) return;
    this.sourceNode = ctx.createBufferSource();
    this.sourceNode.buffer = buf;
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
    }
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.sourceNode.onended = () => {
      this.isPlaying = false;
      if (onEnded) onEnded();
    };
    this.sourceNode.start(0);
    this.startedAt = ctx.currentTime;
    this.isPlaying = true;
  }

  stop() {
    if (this.sourceNode) {
      try { this.sourceNode.onended = null; this.sourceNode.stop(); } catch (e) {}
      this.sourceNode = null;
    }
    this.isPlaying = false;
  }

  get currentTime() {
    if (!this.isPlaying || !this.ctx) return 0;
    return this.ctx.currentTime - this.startedAt;
  }
}
