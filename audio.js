/**
 * Offline Web Audio API piano synthesizer tuned for iOS Safari & PWA playback.
 */

const HARMONIC_WEIGHTS = [1, 0.52, 0.28, 0.16, 0.09, 0.045, 0.02];

export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class PianoAudio {
  #ctx = null;
  #masterGain = null;
  #compressor = null;
  #pianoWave = null;
  #noiseBuffer = null;

  /**
   * Ensures AudioContext is initialized and unlocked on user interaction.
   */
  unlock() {
    if (typeof navigator !== "undefined" && "audioSession" in navigator) {
      try {
        navigator.audioSession.type = "playback";
      } catch {
        // Ignore if unsupported or restricted.
      }
    }

    if (!this.#ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return false;
      }

      this.#ctx = new AudioCtx({ latencyHint: "interactive" });
      this.#compressor = this.#ctx.createDynamicsCompressor();
      this.#compressor.threshold.value = -14;
      this.#compressor.knee.value = 18;
      this.#compressor.ratio.value = 4;
      this.#compressor.attack.value = 0.003;
      this.#compressor.release.value = 0.18;

      this.#masterGain = this.#ctx.createGain();
      this.#masterGain.gain.value = 0.8;

      this.#compressor.connect(this.#masterGain);
      this.#masterGain.connect(this.#ctx.destination);

      this.#pianoWave = this.#buildPianoWave(this.#ctx);
      this.#noiseBuffer = this.#buildHammerNoiseBuffer(this.#ctx);
    }

    if (this.#ctx.state !== "running") {
      this.#ctx.resume().catch(() => {});
      this.#playSilentTick();
    }

    return true;
  }

  #buildPianoWave(ctx) {
    const real = new Float32Array(HARMONIC_WEIGHTS.length + 1);
    const imag = new Float32Array(HARMONIC_WEIGHTS.length + 1);
    for (let i = 0; i < HARMONIC_WEIGHTS.length; i++) {
      imag[i + 1] = HARMONIC_WEIGHTS[i];
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  #buildHammerNoiseBuffer(ctx) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 0.014));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const decay = 1 - i / length;
      data[i] = (Math.random() * 2 - 1) * decay * decay;
    }
    return buffer;
  }

  #playSilentTick() {
    if (!this.#ctx) return;
    try {
      const buffer = this.#ctx.createBuffer(1, 1, this.#ctx.sampleRate);
      const src = this.#ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.#ctx.destination);
      src.start(0);
    } catch {
      // Ignore unlock tick errors.
    }
  }

  /**
   * Plays a note and returns a handle with `.stop()` for clean key release.
   * @param {number} midi
   * @param {'natural' | 'sustained'} mode
   */
  playNote(midi, mode = "natural") {
    if (!this.unlock() || !this.#ctx) {
      return { stop() {} };
    }

    const ctx = this.#ctx;
    const now = ctx.currentTime;
    const freq = midiToFrequency(midi);

    // Subtle pitch-dependent scaling: bass notes ring longer, treble notes brighter initially.
    const pitchNorm = Math.min(1, Math.max(0, (midi - 36) / 60));
    const naturalDecay = 3.2 - pitchNorm * 1.8;

    const voiceGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";

    const startCutoff = Math.min(ctx.sampleRate * 0.42, freq * (8.5 - pitchNorm * 3.5));
    const sustainCutoff = Math.min(ctx.sampleRate * 0.42, freq * (mode === "sustained" ? 2.6 : 2.1));

    filter.frequency.setValueAtTime(startCutoff, now);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(120, sustainCutoff),
      now + (mode === "sustained" ? 0.12 : 0.22)
    );
    filter.Q.value = 0.7;

    // Two slightly detuned unison voices for natural acoustic warmth.
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    oscA.setPeriodicWave(this.#pianoWave);
    oscB.setPeriodicWave(this.#pianoWave);
    oscA.frequency.setValueAtTime(freq, now);
    oscB.frequency.setValueAtTime(freq, now);
    oscA.detune.setValueAtTime(-1.1, now);
    oscB.detune.setValueAtTime(1.1, now);

    const oscBGain = ctx.createGain();
    oscBGain.gain.value = 0.55;

    // Subtle felt hammer transient for clear attack onset.
    const hammerSrc = ctx.createBufferSource();
    hammerSrc.buffer = this.#noiseBuffer;
    const hammerFilter = ctx.createBiquadFilter();
    hammerFilter.type = "bandpass";
    hammerFilter.frequency.value = Math.min(4200, Math.max(450, freq * 2.5));
    hammerFilter.Q.value = 1.1;
    const hammerGain = ctx.createGain();
    hammerGain.gain.value = mode === "sustained" ? 0.045 : 0.09;

    hammerSrc.connect(hammerFilter);
    hammerFilter.connect(hammerGain);
    hammerGain.connect(voiceGain);

    oscA.connect(filter);
    oscB.connect(oscBGain);
    oscBGain.connect(filter);
    filter.connect(voiceGain);
    voiceGain.connect(this.#compressor);

    // Amplitude envelope.
    voiceGain.gain.setValueAtTime(0.0001, now);
    if (mode === "sustained") {
      voiceGain.gain.linearRampToValueAtTime(0.46, now + 0.01);
      voiceGain.gain.exponentialRampToValueAtTime(0.32, now + 0.09);
    } else {
      voiceGain.gain.linearRampToValueAtTime(0.62, now + 0.005);
      voiceGain.gain.exponentialRampToValueAtTime(0.36, now + 0.09);
      voiceGain.gain.exponentialRampToValueAtTime(0.0008, now + naturalDecay);
    }

    oscA.start(now);
    oscB.start(now);
    hammerSrc.start(now);

    let stopped = false;
    let autoStopTimer = null;

    const cleanup = () => {
      try {
        oscA.disconnect();
        oscB.disconnect();
        oscBGain.disconnect();
        hammerSrc.disconnect();
        hammerFilter.disconnect();
        hammerGain.disconnect();
        filter.disconnect();
        voiceGain.disconnect();
      } catch {
        // Already disconnected.
      }
    };

    if (mode === "natural") {
      const autoReleaseMs = Math.ceil((naturalDecay + 0.1) * 1000);
      autoStopTimer = window.setTimeout(() => {
        if (!stopped) {
          stopped = true;
          try {
            oscA.stop();
            oscB.stop();
          } catch {
            // Already stopped.
          }
          cleanup();
        }
      }, autoReleaseMs);
    }

    oscA.onended = cleanup;

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (autoStopTimer !== null) {
          clearTimeout(autoStopTimer);
        }

        const releaseTime = mode === "sustained" ? 0.09 : 0.18;
        const t = ctx.currentTime;
        try {
          if (typeof voiceGain.gain.cancelAndHoldAtTime === "function") {
            voiceGain.gain.cancelAndHoldAtTime(t);
          } else {
            voiceGain.gain.cancelScheduledValues(t);
            voiceGain.gain.setValueAtTime(Math.max(0.0001, voiceGain.gain.value), t);
          }
          voiceGain.gain.exponentialRampToValueAtTime(0.0001, t + releaseTime);
          oscA.stop(t + releaseTime + 0.02);
          oscB.stop(t + releaseTime + 0.02);
        } catch {
          cleanup();
        }
      },
    };
  }
}
