// audioEngine.js
// Web Audio API を用いた通信劣化エフェクトのオフラインレンダリング処理。
// 5系統のノイズを OfflineAudioContext 上で合成し、1本のAudioBufferとして書き出す。

/** @typedef {{ mask:number, radio:number, wind:number, accent:number, dropout:number }} NoiseSettings 各0-100 */

/** 空の（全ゼロの）ノイズ設定 */
export function emptySettings() {
  return { mask: 0, radio: 0, wind: 0, accent: 0, dropout: 0 };
}

/** アップロードされたファイルを AudioBuffer にデコードする */
export async function decodeFile(file, audioCtx) {
  const arrayBuf = await file.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuf);
}

/**
 * 指定したノイズ設定を適用したオーディオを OfflineAudioContext でレンダリングする。
 * @param {AudioBuffer} sourceBuffer
 * @param {NoiseSettings} settings
 * @returns {Promise<AudioBuffer>}
 */
export async function renderProcessedAudio(sourceBuffer, settings) {
  const tail = 0.4; // 効果の余韻用に少し長めに確保
  const duration = sourceBuffer.duration + tail;
  const sampleRate = sourceBuffer.sampleRate;
  const channels = Math.max(1, sourceBuffer.numberOfChannels);

  const ctx = new OfflineAudioContext(channels, Math.ceil(duration * sampleRate), sampleRate);

  const src = ctx.createBufferSource();
  src.buffer = sourceBuffer;

  // ---- ゲインの正規化係数（複数ノイズ加算時の飽和防止） ----
  const voiceGain = ctx.createGain();
  voiceGain.gain.value = 1;

  let node = src;
  node.connect(voiceGain);
  node = voiceGain;

  // === 1. マスク籠り（酸素マスク越しのこもった声） ===
  if (settings.mask > 0) {
    node = applyMaskMuffle(ctx, node, settings.mask);
  }

  // === 2. 英語の訛り（フォルマント色付け + 抑揚・リズムの揺らぎ） ===
  if (settings.accent > 0) {
    node = applyAccentColoring(ctx, node, settings.accent, sourceBuffer.duration);
  }

  // === 3. 無線ノイズ（帯域制限 + ヒス + 軽い歪み） ===
  const radioBus = ctx.createGain();
  radioBus.gain.value = 1;
  node.connect(radioBus);
  let radioNode = radioBus;
  if (settings.radio > 0) {
    radioNode = applyRadioBand(ctx, radioBus, settings.radio);
  }

  // ここまでの声の系統をマスターバスへ
  const master = ctx.createGain();
  master.gain.value = 1;
  radioNode.connect(master);

  // === 追加ノイズベッド：無線ヒス ===
  if (settings.radio > 0) {
    const hiss = createFilteredNoise(ctx, duration, {
      type: 'bandpass',
      freq: 2200,
      Q: 0.6,
    });
    const hissGain = ctx.createGain();
    hissGain.gain.value = (settings.radio / 100) * 0.16;
    hiss.connect(hissGain).connect(master);
    hiss.start(0);
  }

  // === 4. 風切り音（低域ノイズ + ゆったりしたゲイン変動） ===
  if (settings.wind > 0) {
    const wind = createFilteredNoise(ctx, duration, {
      type: 'lowpass',
      freq: 450,
      Q: 0.7,
    });
    const windGustLfo = ctx.createOscillator();
    windGustLfo.frequency.value = 0.15 + (settings.wind / 100) * 0.25;
    const windGustDepth = ctx.createGain();
    windGustDepth.gain.value = (settings.wind / 100) * 0.14;
    const windBaseGain = ctx.createGain();
    windBaseGain.gain.value = (settings.wind / 100) * 0.22;

    windGustLfo.connect(windGustDepth).connect(windBaseGain.gain);
    wind.connect(windBaseGain).connect(master);
    wind.start(0);
    windGustLfo.start(0);
  }

  // === 5. 通信不良の音声途切れ（スケルチ・ドロップアウト） ===
  const dropoutGain = ctx.createGain();
  master.connect(dropoutGain);
  if (settings.dropout > 0) {
    scheduleDropouts(ctx, dropoutGain.gain, sourceBuffer.duration, settings.dropout);
  }

  // === 出力段：簡易リミッター ===
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 12;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;

  const outGain = ctx.createGain();
  outGain.gain.value = 1.15;

  dropoutGain.connect(limiter).connect(outGain).connect(ctx.destination);

  src.start(0);
  return await ctx.startRendering();
}

// ---------------------------------------------------------------------------
// 個別エフェクト実装
// ---------------------------------------------------------------------------

/** マスク籠り：低域寄りのローパス + こもり共鳴のピーキングEQ */
function applyMaskMuffle(ctx, input, intensity) {
  const t = intensity / 100;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 6500 - t * 5600; // 100%で ~900Hz
  lowpass.Q.value = 0.7 + t * 1.8;

  const resonance = ctx.createBiquadFilter();
  resonance.type = 'peaking';
  resonance.frequency.value = 900;
  resonance.Q.value = 1.2;
  resonance.gain.value = t * 7;

  const bodyLoss = ctx.createBiquadFilter();
  bodyLoss.type = 'highshelf';
  bodyLoss.frequency.value = 2500;
  bodyLoss.gain.value = -t * 10;

  input.connect(lowpass).connect(resonance).connect(bodyLoss);
  return bodyLoss;
}

/**
 * 英語の訛り（簡易シミュレーション）
 * 完全な音声変換ではなく、フォルマント帯域の強調位置をずらし、
 * ゆっくりしたゲインLFOで独特の抑揚・語尾の揺れを再現する近似効果。
 */
function applyAccentColoring(ctx, input, intensity, duration) {
  const t = intensity / 100;

  const formantShift1 = ctx.createBiquadFilter();
  formantShift1.type = 'peaking';
  formantShift1.frequency.value = 1800 + t * 500;
  formantShift1.Q.value = 1.5;
  formantShift1.gain.value = t * 6;

  const formantShift2 = ctx.createBiquadFilter();
  formantShift2.type = 'peaking';
  formantShift2.frequency.value = 650 - t * 150;
  formantShift2.Q.value = 1.2;
  formantShift2.gain.value = t * 5;

  const prosodyGain = ctx.createGain();
  prosodyGain.gain.value = 1;

  // 抑揚の揺れ（sing-song ライクなリズム変調）
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1.6 + t * 1.4;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = t * 0.22;
  lfo.connect(lfoDepth).connect(prosodyGain.gain);
  lfo.start(0);
  lfo.stop(duration + 0.4);

  input.connect(formantShift1).connect(formantShift2).connect(prosodyGain);
  return prosodyGain;
}

/** 無線ノイズ：帯域制限 + ソフトクリップ歪み */
function applyRadioBand(ctx, input, intensity) {
  const t = intensity / 100;

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 150 + t * 350; // 最大 ~500Hz

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 7500 - t * 4800; // 最大 ~2700Hz

  const shaper = ctx.createWaveShaper();
  shaper.curve = makeSoftClipCurve(t * 18 + 1);
  shaper.oversample = '2x';

  const makeup = ctx.createGain();
  makeup.gain.value = 1 + t * 0.3;

  input.connect(highpass).connect(lowpass).connect(shaper).connect(makeup);
  return makeup;
}

function makeSoftClipCurve(drive) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return curve;
}

/** ホワイトノイズをフィルタリングしたノイズソースを生成 */
function createFilteredNoise(ctx, duration, { type, freq, Q }) {
  const len = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = false;

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = Q;

  src.connect(filter);
  return { connect: (dest) => (filter.connect(dest), filter), start: (when) => src.start(when) };
}

/** 通信不良によるドロップアウト（音声の途切れ）をゲインオートメーションでスケジュール */
function scheduleDropouts(ctx, gainParam, duration, intensity) {
  const t = intensity / 100;
  gainParam.setValueAtTime(1, 0);

  const avgGapEvery = 3.2 - t * 2.4; // 強度が高いほど頻繁に途切れる（最短 ~0.8秒間隔）
  let time = 0.4 + Math.random() * avgGapEvery;
  const fade = 0.012;

  while (time < duration) {
    const gapLen = 0.06 + Math.random() * (0.1 + t * 0.35); // 60ms〜最大450ms程度
    const start = time;
    const end = Math.min(duration, time + gapLen);

    gainParam.setValueAtTime(1, Math.max(0, start - fade));
    gainParam.linearRampToValueAtTime(0, start);
    gainParam.setValueAtTime(0, end);
    gainParam.linearRampToValueAtTime(1, Math.min(duration + 0.3, end + fade));

    time = end + avgGapEvery * (0.5 + Math.random());
  }
}
