# Comtrade Analyzer

A modern, fully client-side web app for analyzing IEEE/IEC Comtrade files. Everything runs locally in your browser — no internet connection required, no cloud storage, no data ever leaves your machine.

## Features

- **Waveform plots** — interactive time-domain visualization of analog channels (voltage, current)
- **Digital channel display** — square-wave view of on/off status channels over time
- **FFT / frequency analysis** — frequency spectrum for any analog channel with Hann windowing
- **Channel statistics** — RMS, peak, min, max, and frequency estimate per analog channel
- **Demo mode** — built-in synthetic 3-phase fault record to explore the app without a real file

## Supported Formats

| Comtrade Version | ASCII | Binary (int16) | Binary32 / Float32 |
|---|---|---|---|
| 1991 | ✓ | ✓ | — |
| 1999 | ✓ | ✓ | — |
| 2013 | ✓ | ✓ | ✓ |

## Usage

1. Clone or download this repository
2. Open `index.html` in any modern browser
3. Drag and drop your `.cfg` and `.dat` files onto the app, or use the file picker
4. Use the sidebar to select channels and switch between views

No installation, no build step, no dependencies to install.

## Project Structure

```
comtrade-analyzer/
├── index.html          # App layout and entry point
├── style.css           # Dark theme, responsive layout
├── app.js              # UI wiring and Plotly chart rendering
├── comtrade.js         # .cfg and .dat file parser
├── fft.js              # Cooley-Tukey FFT implementation
└── plotly-2.26.0.min.js  # Bundled Plotly.js (fully offline)
```

## Privacy

All file processing happens in the browser using the FileReader API. No data is uploaded anywhere.
