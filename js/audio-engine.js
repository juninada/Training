/**
 * audio-engine.js — decodes uploaded audio and plays it back through a
 * Web Audio graph that degrades the signal to emulate realistic R/T
 * listening conditions. All five effects are additive/parallel and are
 * snapshotted from the slider values at the moment PLAY is pressed.
 *
 * Effects:
 *  - mask   : マスク籠り      — lowpass + resonant peak (O2 mask cavity)
 *  - radio  : 無線ノイズ      — bandwidth-limit + hiss + soft clip, dry/wet
 *  - wind   : 風切り音        — filtered brown noise bed with gust LFO
 *  - accent : 英語の訛り(簡易) — playbackRate/detune LFO wobble (a DSP-only
 *             approximation of non-native cadence/intonation; it does not
 *             perform true accent conversion)
 *  - dropout: 通信不良の音声途切れ — scheduled gain gating (comms cut-outs)
 */
const AudioEngine = (() => {

  const lerp = (a, b, t) => a + (b - a) * t;

  class Engine {
    constructor() {
      this.ctx = null;
      this._nodes = null;
      this._rafId = null;
    }

    ensureContext() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this._noiseBufs = {
          white: NoiseGen.whiteNoiseBuffer(this.ctx, 4),
          brown: NoiseGen.brownNoiseBuffer(this.ctx, 6),
        };
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    async decodeFile(file) {
      const ctx = this.ensureContext();
      const arrayBuf = await file.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
      return audioBuf;
    }

    _buildDistortionCurve(amount) {
      const k = 1 + amount * 9;
      const n = 1024;
      const curve = new Float32Array(n);
      const norm = Math.tanh(k);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x) / norm;
      }
      return curve;
    }

    /** Builds a randomized signal-loss schedule: [{start, dur}] in seconds. */
    _buildDropoutSchedule(duration, intensity) {
      if (intensity <= 0.01) return [];
      const rate = lerp(0.05, 1.4, intensity);      // dropouts per second (avg)
      const avgDur = lerp(0.04, 0.32, intensity);    // seconds per dropout
      const events = [];
      let t = lerp(0.6, 0.15, intensity);            // give a short clear start
      while (t < duration) {
        const gap = -Math.log(1 - Math.random()) / rate; // exponential inter-arrival
        t += gap;
        if (t >= duration) break;
        const d = Math.max(0.03, avgDur * (0.5 + Math.random()));
        events.push({ start: t, dur: Math.min(d, duration - t) });
        t += d;
      }
      return events;
    }

    stop() {
      if (this._nodes && this._nodes.source) {
        // detach onended first so a stale finish() callback from the
        // previous play() never fires after a new play() has begun.
        try { this._nodes.source.onended = null; } catch (e) { /* noop */ }
        for (const key of ['source', 'hissSrc', 'windSrc', 'accentLFO', 'accentLFO2', 'windLFO']) {
          const n = this._nodes[key];
          if (n) { try { n.stop(); } catch (e) { /* already stopped */ } }
        }
      }
      if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
      this._nodes = null;
    }

    /**
     * Plays `buffer` through the effect chain.
     * @param {AudioBuffer} buffer
     * @param {{mask:number,radio:number,wind:number,accent:number,dropout:number}} params 0-100 each
     * @param {{onProgress:Function, onEnded:Function}} callbacks
     */
    play(buffer, params, { onProgress, onEnded } = {}) {
      this.stop();
      const ctx = this.ensureContext();
      const now = ctx.currentTime + 0.05;
      const duration = buffer.duration;

      const m = {
        mask: (params.mask || 0) / 100,
        radio: (params.radio || 0) / 100,
        wind: (params.wind || 0) / 100,
        accent: (params.accent || 0) / 100,
        dropout: (params.dropout || 0) / 100,
      };

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      // --- accent (simulated): wobble playbackRate + detune ---
      source.playbackRate.value = 1;
      source.detune.value = 0;
      let accentLFO = null, accentLFO2 = null;
      if (m.accent > 0.01) {
        accentLFO = ctx.createOscillator();
        accentLFO.frequency.value = lerp(0.25, 0.7, m.accent);
        const depthRate = ctx.createGain();
        depthRate.gain.value = lerp(0.01, 0.11, m.accent); // +/- fraction of playbackRate
        accentLFO.connect(depthRate).connect(source.playbackRate);

        accentLFO2 = ctx.createOscillator();
        accentLFO2.type = 'triangle';
        accentLFO2.frequency.value = lerp(0.4, 1.1, m.accent);
        const depthDetune = ctx.createGain();
        depthDetune.gain.value = lerp(8, 55, m.accent); // cents
        accentLFO2.connect(depthDetune).connect(source.detune);

        accentLFO.start(now); accentLFO2.start(now);
      }

      // --- mask muffle: lowpass + resonant peak ---
      const maskLowpass = ctx.createBiquadFilter();
      maskLowpass.type = 'lowpass';
      maskLowpass.frequency.value = lerp(9000, 650, m.mask);
      maskLowpass.Q.value = lerp(0.7, 1.1, m.mask);

      const maskPeak = ctx.createBiquadFilter();
      maskPeak.type = 'peaking';
      maskPeak.frequency.value = 420;
      maskPeak.Q.value = lerp(1, 3.2, m.mask);
      maskPeak.gain.value = lerp(0, 9, m.mask);

      source.connect(maskLowpass);
      maskLowpass.connect(maskPeak);

      // --- radio noise: bandwidth limit + soft clip, crossfaded with dry ---
      const radioHP = ctx.createBiquadFilter();
      radioHP.type = 'highpass';
      radioHP.frequency.value = 300;
      const radioLP = ctx.createBiquadFilter();
      radioLP.type = 'lowpass';
      radioLP.frequency.value = 3400;
      const radioShaper = ctx.createWaveShaper();
      radioShaper.curve = this._buildDistortionCurve(m.radio);
      radioShaper.oversample = '2x';

      const gainDry = ctx.createGain();
      gainDry.gain.value = 1 - m.radio * 0.9;
      const gainWet = ctx.createGain();
      gainWet.gain.value = m.radio;

      const preMix = ctx.createGain(); // sum point before ambient beds
      maskPeak.connect(gainDry).connect(preMix);
      maskPeak.connect(radioHP);
      radioHP.connect(radioLP);
      radioLP.connect(radioShaper);
      radioShaper.connect(gainWet).connect(preMix);

      // radio hiss bed
      let hissSrc = null;
      if (m.radio > 0.01) {
        hissSrc = ctx.createBufferSource();
        hissSrc.buffer = this._noiseBufs.white;
        hissSrc.loop = true;
        const hissBP = ctx.createBiquadFilter();
        hissBP.type = 'bandpass';
        hissBP.frequency.value = 1800;
        hissBP.Q.value = 0.6;
        const hissGain = ctx.createGain();
        hissGain.gain.value = m.radio * 0.10;
        hissSrc.connect(hissBP).connect(hissGain).connect(preMix);
      }

      // --- wind: filtered brown noise bed with slow gust LFO ---
      let windSrc = null, windLFO = null;
      if (m.wind > 0.01) {
        windSrc = ctx.createBufferSource();
        windSrc.buffer = this._noiseBufs.brown;
        windSrc.loop = true;
        const windLP = ctx.createBiquadFilter();
        windLP.type = 'lowpass';
        windLP.frequency.value = lerp(500, 1100, m.wind);
        const windGain = ctx.createGain();
        windGain.gain.value = m.wind * 0.30;
        windLFO = ctx.createOscillator();
        windLFO.frequency.value = 0.13;
        const windLFODepth = ctx.createGain();
        windLFODepth.gain.value = m.wind * 0.12;
        windLFO.connect(windLFODepth).connect(windGain.gain);
        windSrc.connect(windLP).connect(windGain).connect(preMix);
        windLFO.start(now);
      }

      // --- dropout: scheduled gain gating on the full mix ---
      const dropoutGain = ctx.createGain();
      dropoutGain.gain.value = 1;
      preMix.connect(dropoutGain);
      const schedule = this._buildDropoutSchedule(duration, m.dropout);
      const FADE = 0.006;
      for (const ev of schedule) {
        const t0 = now + ev.start;
        const t1 = Math.min(t0 + ev.dur, now + duration);
        dropoutGain.gain.setValueAtTime(1, Math.max(now, t0 - FADE));
        dropoutGain.gain.linearRampToValueAtTime(0.04, t0);
        dropoutGain.gain.setValueAtTime(0.04, Math.max(t0, t1 - FADE));
        dropoutGain.gain.linearRampToValueAtTime(1, t1);
      }

      const master = ctx.createGain();
      master.gain.value = 1;
      dropoutGain.connect(master).connect(ctx.destination);

      source.start(now);
      if (hissSrc) hissSrc.start(now);
      if (windSrc) windSrc.start(now);
      const stopAt = now + duration;
      source.stop(stopAt + 0.1);
      if (hissSrc) hissSrc.stop(stopAt + 0.1);
      if (windSrc) windSrc.stop(stopAt + 0.1);
      if (accentLFO) { accentLFO.stop(stopAt + 0.1); accentLFO2.stop(stopAt + 0.1); }

      this._nodes = { source, hissSrc, windSrc, accentLFO, accentLFO2, windLFO };

      const startedAt = now;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (onProgress) onProgress(duration, duration);
        if (onEnded) onEnded();
        this._nodes = null;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
      };
      const tick = () => {
        const elapsed = ctx.currentTime - startedAt;
        if (elapsed >= duration) { finish(); return; }
        if (onProgress) onProgress(Math.max(0, elapsed), duration);
        this._rafId = requestAnimationFrame(tick);
      };
      this._rafId = requestAnimationFrame(tick);

      // onended can fire slightly before/after our rAF loop notices;
      // `finish()` is idempotent so the UI settles exactly once.
      source.onended = finish;
    }
  }

  return { Engine };
})();
