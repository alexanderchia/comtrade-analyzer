/* ============================================================
 * fft.js — radix-2 Cooley-Tukey FFT (iterative, in-place)
 * No external dependencies.
 * ============================================================ */
"use strict";

const FFT = (() => {

  /**
   * In-place iterative radix-2 Cooley-Tukey FFT.
   * @param {Float64Array} re real parts (length must be a power of 2)
   * @param {Float64Array} im imaginary parts (same length)
   */
  function transform(re, im) {
    const n = re.length;
    if (n !== im.length) throw new Error("FFT: re/im length mismatch");
    if (n === 0 || (n & (n - 1)) !== 0) {
      throw new Error("FFT: length must be a power of 2, got " + n);
    }

    // --- bit-reversal permutation ---
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    // --- butterflies ---
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = -2 * Math.PI / len;
      const wStepRe = Math.cos(ang);
      const wStepIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const tRe = re[b] * wRe - im[b] * wIm;
          const tIm = re[b] * wIm + im[b] * wRe;
          re[b] = re[a] - tRe;
          im[b] = im[a] - tIm;
          re[a] += tRe;
          im[a] += tIm;
          const nwRe = wRe * wStepRe - wIm * wStepIm;
          wIm = wRe * wStepIm + wIm * wStepRe;
          wRe = nwRe;
        }
      }
    }
  }

  /** Largest power of two <= n (n >= 1). */
  function floorPow2(n) {
    let p = 1;
    while (p * 2 <= n) p *= 2;
    return p;
  }

  /**
   * One-sided amplitude spectrum of a real signal.
   * The signal is mean-removed, Hann-windowed and truncated to the
   * largest power-of-2 length before transforming. Amplitudes are
   * corrected for the window's coherent gain so a pure sinusoid of
   * amplitude A shows a peak of ~A.
   *
   * @param {number[]|Float64Array} signal time-domain samples
   * @param {number} fs sample rate in Hz
   * @returns {{freqs: Float64Array, mags: Float64Array, n: number}}
   */
  function amplitudeSpectrum(signal, fs) {
    const usable = [];
    for (let i = 0; i < signal.length; i++) {
      usable.push(Number.isFinite(signal[i]) ? signal[i] : 0);
    }
    if (usable.length < 8) throw new Error("FFT: not enough samples (need at least 8)");

    const n = floorPow2(usable.length);

    // mean removal (over the analysed segment)
    let mean = 0;
    for (let i = 0; i < n; i++) mean += usable[i];
    mean /= n;

    // Hann window
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let windowSum = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      re[i] = (usable[i] - mean) * w;
      windowSum += w;
    }

    transform(re, im);

    const half = n >> 1;
    const freqs = new Float64Array(half + 1);
    const mags = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      freqs[k] = (k * fs) / n;
      // one-sided amplitude, corrected for window coherent gain
      const scale = (k === 0 || k === half) ? 1 : 2;
      mags[k] = (scale * Math.hypot(re[k], im[k])) / windowSum;
    }
    return { freqs, mags, n };
  }

  return { transform, amplitudeSpectrum, floorPow2 };
})();
