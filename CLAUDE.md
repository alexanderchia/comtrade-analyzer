# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step or server required. Open `index.html` directly in a browser:

```
open index.html
```

All assets are local (`plotly-2.26.0.min.js` is bundled). The app runs fully offline.

## Architecture

This is a zero-dependency, single-page browser app. Script load order in `index.html` matters:

1. `fft.js` — exposes `FFT` global
2. `comtrade.js` — exposes `Comtrade` global
3. `app.js` — wires everything together; depends on both globals above

### `comtrade.js` — parser

Exposes the `Comtrade` namespace with three public functions:

- `Comtrade.parseCfg(text)` → cfg object
- `Comtrade.parseRecord(cfg, datContent)` → record object (datContent is `string` for ASCII, `ArrayBuffer` for binary)
- `Comtrade.channelStats(values, time)` → `{ rms, peak, min, max, mean, freq }`

The record object shape:
```js
{
  cfg,           // parsed config
  count,         // number of samples
  time,          // Float64Array — seconds from first sample
  analog,        // Float64Array[] — one per channel, scaled to engineering units
  digital,       // Uint8Array[] — one per channel (0 or 1)
  sampleRate,    // Hz (from CFG sampleRates[0].samp, or derived from DAT timestamps)
  duration,      // seconds
  warnings       // string[]
}
```

Analog values are scaled on read: `raw * ch.a + ch.b`. BINARY format is int16, BINARY32 is int32, FLOAT32 stores raw floats.

### `fft.js` — FFT

Exposes `FFT.amplitudeSpectrum(signal, fs)` → `{ freqs, mags, n }`. Internally pads/truncates to power-of-2, applies mean removal and Hann windowing, then scales for coherent gain. Also exposes `FFT.transform(re, im)` (in-place) and `FFT.floorPow2(n)`.

### `app.js` — UI and rendering

Single IIFE. All state lives in one object:

```js
const state = {
  pendingCfg, pendingDat,   // File objects awaiting the pair
  record,                    // active parsed record
  selectedAnalog,            // Set<number> — channel indices
  selectedDigital,           // Set<number> — channel indices
  xRange,                   // [min, max] in display units (null = full range)
  xInCycles,                // boolean — seconds vs cycles x-axis
  showPoints,               // boolean — render markers on traces
  reRenderTimer             // debounce for adaptive re-render after zoom
}
```

**Channel classification** (`channelType`, `splitSelectedAnalog`): channels are split into voltage/current by their `units` field using regex (`/[kmµ]?v$/` = voltage, `/[kmµ]?a$|[kmµ]?i$/` = current). Falls back to index-halving if no units are recognized. This split drives which waveform and RMS cards are populated and shown/hidden.

**Phase coloring**: A=`#e05252` (red), B=`#3fb950` (green), C=`#4cc2ff` (blue). Phase is read from `ch.phase` first, then last character of `ch.name`. Falls back to the `PALETTE` array by channel index.

**Decimation**: `decimate(time, values, maxPoints)` uses min/max bucketing (envelope-preserving). Limits are `MAX_PLOT_POINTS=8000` (lines only) and `MAX_PLOT_POINTS_MARK=500` (with markers). Zooming triggers adaptive re-render via `filterToRange` + `decimate` on the visible window, debounced at 350 ms.

**Axis sync**: All time-domain plots (voltage waveform, voltage RMS, current waveform, current RMS, digital) share `state.xRange` via `plotly_relayout` events. A 150 ms debounce prevents feedback loops between plots.

**Plotly usage**: `Plotly.react()` is used everywhere (idempotent upsert). `darkLayout(extra)` merges dark-theme defaults. `PLOT_CONFIG` removes lasso, select, and autoscale toolbar buttons.

**Demo record**: `buildDemoRecord()` synthesizes a 300 ms, 4800 Hz, 3-phase A-phase-to-ground fault (60 Hz) entirely in ASCII Comtrade format in memory — no file I/O needed.

## Key conventions

- `record.time` is always in **seconds** relative to the first sample. Display conversion (`toDisplayX`) applies only when building Plotly trace `x` arrays.
- `state.xRange` stores values in **display units** (seconds or cycles depending on `state.xInCycles`). Conversion happens in `visibleRangeSeconds()` before filtering.
- All Plotly div IDs follow the pattern `{voltage|current}-{waveform|rms}-plot` and `digital-plot`, `fft-plot`.
- Empty-state hints use sibling `<p>` elements with IDs like `voltage-waveform-empty`; toggled with `.hidden`.
