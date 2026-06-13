/* ============================================================
 * app.js — Comtrade Analyzer UI
 * Wires file loading, channel selection, Plotly charts,
 * FFT panel and statistics table together.
 * ============================================================ */
"use strict";

(() => {

  /* ---------------- state ---------------- */

  const state = {
    pendingCfg: null,   // File
    pendingDat: null,   // File
    record: null,       // parsed record from Comtrade.parseRecord
    selectedAnalog: new Set(),
    selectedDigital: new Set(),
    xRange: null,       // shared x-axis range [min, max] for waveform + RMS plots
    lastSyncMs: 0,      // timestamp of last axis sync, debounces relayout feedback loops
    xInCycles: false,   // when true, time-domain x-axes are shown in cycles instead of seconds
    showPoints: false   // when true, time-series traces also render markers at sampled points
  };

  /* ---------------- x-axis units ---------------- */

  // Line frequency used to convert seconds <-> cycles (50/60 Hz, fallback 60).
  function lineFreq() {
    return (state.record && state.record.cfg.lineFrequency) || 60;
  }

  // Map an array of times (in seconds) to display units (seconds or cycles).
  function toDisplayX(timeArr) {
    if (!state.xInCycles) return timeArr;
    const f = lineFreq();
    const out = new Array(timeArr.length);
    for (let i = 0; i < timeArr.length; i++) out[i] = timeArr[i] * f;
    return out;
  }

  function xAxisLabel() {
    return state.xInCycles ? "Cycles" : "Time (s)";
  }

  const PALETTE = [
    "#4cc2ff", "#ff7a5c", "#3fb950", "#e3b341", "#bc8cff",
    "#ff7ab8", "#56d4dd", "#f0883e", "#7ee787", "#a5d6ff",
    "#ffa198", "#d2a8ff", "#79c0ff", "#ffdf5d", "#56d364"
  ];
  const PHASE_COLORS = { A: "#e05252", B: "#4cc2ff", C: "#3fb950" };
  const analogColor = (i, ch) => {
    if (ch) {
      // Try explicit phase field first, then fall back to last char of channel name.
      const src = (ch.phase && ch.phase.trim()) ? ch.phase.trim() : (ch.name || "");
      const p = src.toUpperCase().slice(-1);
      if (PHASE_COLORS[p]) return PHASE_COLORS[p];
    }
    return PALETTE[i % PALETTE.length];
  };

  const MAX_PLOT_POINTS = 8000; // per analog trace, min/max decimated

  /* ---------------- channel classification ---------------- */

  // Classify an analog channel as "voltage" or "current" by its units field.
  function channelType(ch) {
    const u = (ch.units || "").toLowerCase().trim();
    if (/[kmµ]?v$/.test(u)) return "voltage";
    if (/[kmµ]?a$/.test(u) || /[kmµ]?i$/.test(u)) return "current";
    return "voltage"; // fallback
  }

  // Split the currently selected analog indices into voltage and current groups.
  // Falls back to index halves when units are absent/unrecognized for all channels.
  function splitSelectedAnalog() {
    const record = state.record;
    if (!record) return { voltageIdxs: [], currentIdxs: [] };
    const channels = record.cfg.analogChannels;
    const idxs = [...state.selectedAnalog].sort((a, b) => a - b)
      .filter(i => i < record.cfg.nAnalog);

    // Detect whether any channel has a recognizable unit; if none do, use index split.
    const anyRecognized = channels.some(ch => {
      const u = (ch.units || "").toLowerCase().trim();
      return /[kmµ]?v$/.test(u) || /[kmµ]?a$/.test(u) || /[kmµ]?i$/.test(u);
    });

    const voltageIdxs = [], currentIdxs = [];
    if (anyRecognized) {
      for (const i of idxs) {
        if (channelType(channels[i]) === "current") currentIdxs.push(i);
        else voltageIdxs.push(i);
      }
    } else {
      const half = Math.ceil(record.cfg.nAnalog / 2);
      for (const i of idxs) {
        if (i < half) voltageIdxs.push(i); else currentIdxs.push(i);
      }
    }
    return { voltageIdxs, currentIdxs };
  }

  // Indices (regardless of selection) of voltage/current channels — used to
  // decide which cards to show in presentRecord.
  function typedChannelCounts(record) {
    const channels = record.cfg.analogChannels;
    const anyRecognized = channels.some(ch => {
      const u = (ch.units || "").toLowerCase().trim();
      return /[kmµ]?v$/.test(u) || /[kmµ]?a$/.test(u) || /[kmµ]?i$/.test(u);
    });
    let voltage = 0, current = 0;
    if (anyRecognized) {
      channels.forEach(ch => {
        if (channelType(ch) === "current") current++; else voltage++;
      });
    } else {
      const half = Math.ceil(channels.length / 2);
      channels.forEach((_, i) => { if (i < half) voltage++; else current++; });
    }
    return { voltage, current };
  }

  /* ---------------- DOM ---------------- */

  const $ = id => document.getElementById(id);
  const dropZone = $("drop-zone");
  const fileInput = $("file-input");

  const PLOT_CONFIG = { responsive: true, displaylogo: false,
                        modeBarButtonsToRemove: ["lasso2d", "select2d"] };

  /* ---------------- messages ---------------- */

  function showMessage(msg, kind) {
    const banner = $("error-banner");
    banner.classList.remove("hidden", "warn");
    if (kind === "warn") banner.classList.add("warn");
    $("error-text").textContent = msg;
  }
  const showError = msg => showMessage(msg, "error");
  const showWarning = msg => showMessage(msg, "warn");
  function clearMessage() { $("error-banner").classList.add("hidden"); }
  $("error-close").addEventListener("click", clearMessage);

  /* ---------------- file loading ---------------- */

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error(`Could not read "${file.name}".`));
      r.readAsText(file);
    });
  }

  function readAsBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error(`Could not read "${file.name}".`));
      r.readAsArrayBuffer(file);
    });
  }

  const baseName = name => name.replace(/\.[^.]+$/, "");

  function updateSlot(slotId, nameId, file) {
    const slot = $(slotId);
    if (file) {
      slot.classList.add("filled");
      $(nameId).textContent = file.name;
    } else {
      slot.classList.remove("filled");
      $(nameId).textContent = "waiting…";
    }
  }

  function acceptFiles(fileList) {
    clearMessage();
    const rejected = [];
    for (const f of fileList) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (ext === "cfg") state.pendingCfg = f;
      else if (ext === "dat") state.pendingDat = f;
      else rejected.push(f.name);
    }
    updateSlot("slot-cfg", "slot-cfg-name", state.pendingCfg);
    updateSlot("slot-dat", "slot-dat-name", state.pendingDat);

    if (rejected.length) {
      showWarning(
        `Ignored unsupported file(s): ${rejected.join(", ")}. ` +
        `Please provide a .cfg and a .dat file. ` +
        `(Combined .cff files are not supported — extract the .cfg/.dat pair.)`);
    }
    if (state.pendingCfg && state.pendingDat) {
      loadPair(state.pendingCfg, state.pendingDat);
    }
  }

  async function loadPair(cfgFile, datFile) {
    try {
      const warnings = [];
      if (baseName(cfgFile.name).toLowerCase() !== baseName(datFile.name).toLowerCase()) {
        warnings.push(
          `File names differ ("${cfgFile.name}" vs "${datFile.name}") — ` +
          `make sure they belong to the same record.`);
      }

      const cfgText = await readAsText(cfgFile);
      const cfg = Comtrade.parseCfg(cfgText);

      const datContent = cfg.fileType === "ASCII"
        ? await readAsText(datFile)
        : await readAsBuffer(datFile);

      const record = Comtrade.parseRecord(cfg, datContent);
      record.warnings = warnings.concat(record.warnings);
      record.sourceName = baseName(cfgFile.name);
      presentRecord(record);
    } catch (err) {
      console.error(err);
      showError(err && err.message ? err.message : String(err));
    }
  }

  /* ---------------- drop zone wiring ---------------- */

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  $("browse-btn").addEventListener("click", e => {
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) acceptFiles(fileInput.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach(ev =>
    dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    }));
  ["dragleave", "drop"].forEach(ev =>
    dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    }));
  dropZone.addEventListener("drop", e => {
    if (e.dataTransfer && e.dataTransfer.files.length) acceptFiles(e.dataTransfer.files);
  });
  // Allow dropping anywhere on the page without the browser navigating away.
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => e.preventDefault());

  /* ---------------- presentation ---------------- */

  function presentRecord(record) {
    if (typeof Plotly === "undefined") {
      showError("Plotly.js failed to load from the CDN. Charts need an internet " +
                "connection the first time (or save plotly-2.26.0.min.js locally " +
                "and point the <script> tag at it).");
      return;
    }
    state.record = record;
    state.xRange = null;
    state.xInCycles = false;
    state.showPoints = false;
    $("show-points-toggle").checked = false;
    updateCyclesButton();
    const vIdxs = record.cfg.analogChannels
      .map((ch, i) => channelType(ch) === "voltage" ? i : -1).filter(i => i >= 0);
    const iIdxs = record.cfg.analogChannels
      .map((ch, i) => channelType(ch) === "current" ? i : -1).filter(i => i >= 0);
    state.selectedAnalog = new Set([...vIdxs.slice(0, 4), ...iIdxs.slice(0, 4)]);
    state.selectedDigital = new Set(
      record.digital.map((_, i) => i).slice(0, record.cfg.nDigital <= 12 ? 12 : 8));

    if (record.warnings.length) showWarning(record.warnings.join("\n"));
    else clearMessage();

    $("welcome").classList.add("hidden");
    $("results").classList.remove("hidden");

    const badge = $("record-badge");
    badge.textContent = `${record.cfg.stationName} — ${record.sourceName}`;
    badge.classList.remove("hidden");

    renderRecordInfo(record);
    renderChannelLists(record);

    // Show/hide the voltage and current cards based on which channel types exist.
    const counts = typedChannelCounts(record);
    const hasVoltage = counts.voltage > 0;
    const hasCurrent = counts.current > 0;
    $("voltage-waveform-card").classList.toggle("hidden", !hasVoltage);
    $("voltage-rms-card").classList.toggle("hidden", !hasVoltage);
    $("current-waveform-card").classList.toggle("hidden", !hasCurrent);
    $("current-rms-card").classList.toggle("hidden", !hasCurrent);

    renderWaveforms();
    renderRmsCharts();
    renderDigital();
    setupAxisSync();
    populateFftChannels(record);
    renderFft();
    renderStats(record);
  }

  function renderRecordInfo(record) {
    const cfg = record.cfg;
    const rows = [
      ["Station", cfg.stationName],
      ["Device ID", cfg.deviceId || "—"],
      ["Revision", String(cfg.revision)],
      ["Data format", cfg.fileType],
      ["Analog channels", String(cfg.nAnalog)],
      ["Digital channels", String(cfg.nDigital)],
      ["Line frequency", cfg.lineFrequency ? `${cfg.lineFrequency} Hz` : "—"],
      ["Sample rate", `${fmt(record.sampleRate, 6)} Hz` +
        (cfg.sampleRates.length > 1 ? ` (${cfg.sampleRates.length} segments)` : "")],
      ["Samples", String(record.count)],
      ["Duration", `${fmt(record.duration * 1000, 6)} ms`],
      ["First sample", cfg.startTime || "—"],
      ["Trigger", cfg.triggerTime || "—"]
    ];
    if (cfg.revision === 2013 || cfg.timeMult !== 1) {
      rows.push(["Time multiplier", String(cfg.timeMult)]);
    }
    const table = $("record-info");
    table.innerHTML = "";
    for (const [k, v] of rows) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      const td2 = document.createElement("td");
      td1.textContent = k;
      td2.textContent = v;
      tr.append(td1, td2);
      table.appendChild(tr);
    }
    $("record-info-panel").classList.remove("hidden");
  }

  function renderChannelLists(record) {
    buildChannelList($("analog-list"), record.cfg.analogChannels, state.selectedAnalog,
      (i, ch) => `${ch.units || ""}`, (i, ch) => analogColor(i, ch),
      () => { renderWaveforms(); renderRmsCharts(); });
    $("analog-panel").classList.toggle("hidden", record.cfg.nAnalog === 0);

    buildChannelList($("digital-list"), record.cfg.digitalChannels, state.selectedDigital,
      (i, ch) => ch.normalState ? "N=1" : "N=0", () => "#9aa7b4",
      () => { renderDigital(); });
    $("digital-panel").classList.toggle("hidden", record.cfg.nDigital === 0);
  }

  function buildChannelList(ul, channels, selectedSet, metaFn, colorFn, onChange) {
    ul.innerHTML = "";
    channels.forEach((ch, i) => {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedSet.has(i);
      cb.addEventListener("change", () => {
        if (cb.checked) selectedSet.add(i); else selectedSet.delete(i);
        onChange();
      });
      const swatch = document.createElement("span");
      swatch.className = "chan-swatch";
      swatch.style.background = colorFn(i);
      const name = document.createElement("span");
      name.className = "chan-name";
      name.textContent = ch.name + (ch.phase ? ` (${ch.phase})` : "");
      name.title = name.textContent;
      const meta = document.createElement("span");
      meta.className = "chan-meta";
      meta.textContent = metaFn(i, ch);
      label.append(cb, swatch, name, meta);
      li.appendChild(label);
      ul.appendChild(li);
    });
  }

  function setAll(selectedSet, count, on, listId, rerender) {
    selectedSet.clear();
    if (on) for (let i = 0; i < count; i++) selectedSet.add(i);
    $(listId).querySelectorAll("input[type=checkbox]")
      .forEach((cb, i) => { cb.checked = selectedSet.has(i); });
    rerender();
  }
  $("analog-all").addEventListener("click", () => {
    setAll(state.selectedAnalog, state.record.cfg.nAnalog, true, "analog-list", renderWaveforms);
    renderRmsCharts();
  });
  $("analog-none").addEventListener("click", () => {
    setAll(state.selectedAnalog, state.record.cfg.nAnalog, false, "analog-list", renderWaveforms);
    renderRmsCharts();
  });
  $("digital-all").addEventListener("click", () =>
    setAll(state.selectedDigital, state.record.cfg.nDigital, true, "digital-list", renderDigital));
  $("digital-none").addEventListener("click", () =>
    setAll(state.selectedDigital, state.record.cfg.nDigital, false, "digital-list", renderDigital));

  /* ---------------- Plotly helpers ---------------- */

  function darkLayout(extra) {
    return Object.assign({
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: "#9aa7b4", size: 12,
              family: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" },
      margin: { l: 80, r: 20, t: 10, b: 45 },
      xaxis: { gridcolor: "#222c3a", zerolinecolor: "#2b3442", linecolor: "#2b3442" },
      yaxis: { gridcolor: "#222c3a", zerolinecolor: "#2b3442", linecolor: "#2b3442" },
      legend: { orientation: "h", y: 1.12, font: { color: "#c8d2dc" } },
      hovermode: "x unified",
      hoverlabel: { bgcolor: "#1c2330", bordercolor: "#2b3442", font: { color: "#e6edf3" } }
    }, extra);
  }

  /** Min/max decimation that preserves the waveform envelope. */
  function decimate(time, values, maxPoints) {
    const n = values.length;
    if (n <= maxPoints) return { x: Array.from(time), y: Array.from(values) };
    const buckets = Math.floor(maxPoints / 2);
    const x = [], y = [];
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor((b * n) / buckets);
      const end = Math.max(start + 1, Math.floor(((b + 1) * n) / buckets));
      let minI = -1, maxI = -1, minV = Infinity, maxV = -Infinity;
      for (let i = start; i < end; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        if (v < minV) { minV = v; minI = i; }
        if (v > maxV) { maxV = v; maxI = i; }
      }
      if (minI === -1) continue;
      if (minI <= maxI) {
        x.push(time[minI], time[maxI]); y.push(values[minI], values[maxI]);
      } else {
        x.push(time[maxI], time[minI]); y.push(values[maxI], values[minI]);
      }
    }
    return { x, y };
  }

  /* ---------------- waveform plot ---------------- */

  function renderWaveformChart(plotDivId, emptyHintId, channelIdxs) {
    const record = state.record;
    if (!record) return;
    const div = $(plotDivId);
    const idxs = channelIdxs;

    $(emptyHintId).classList.toggle("hidden", idxs.length > 0);
    if (idxs.length === 0) { Plotly.purge(div); div.innerHTML = ""; return; }

    const perUnit = $("per-unit-toggle").checked;
    const traces = idxs.map(i => {
      const ch = record.cfg.analogChannels[i];
      let values = record.analog[i];
      if (perUnit) {
        const s = Comtrade.channelStats(values, record.time);
        const denom = s.peak > 0 ? s.peak : 1;
        const norm = new Float64Array(values.length);
        for (let k = 0; k < values.length; k++) norm[k] = values[k] / denom;
        values = norm;
      }
      const d = decimate(record.time, values, MAX_PLOT_POINTS);
      return {
        x: toDisplayX(d.x), y: d.y,
        type: "scatter", mode: state.showPoints ? "lines+markers" : "lines",
        name: ch.name + (ch.units && !perUnit ? ` [${ch.units}]` : ""),
        line: { color: analogColor(i, ch), width: 1.4 },
        marker: { size: 3 },
        hovertemplate: "%{y:.4g}" + (perUnit ? " pu" : (ch.units ? " " + ch.units : "")) +
                       "<extra>" + escapeHtml(ch.name) + "</extra>"
      };
    });

    const units = new Set(idxs.map(i => record.cfg.analogChannels[i].units).filter(Boolean));
    const yTitle = perUnit ? "Normalized amplitude"
                 : (units.size === 1 ? [...units][0] : "Value (mixed units)");

    const xRange = state.xRange ||
      toDisplayX([record.time[0], record.time[record.count - 1]]);
    Plotly.react(div, traces, darkLayout({
      xaxis: Object.assign(darkLayout().xaxis, { title: { text: xAxisLabel() }, range: xRange }),
      yaxis: Object.assign(darkLayout().yaxis, { title: { text: yTitle } })
    }), PLOT_CONFIG);
  }

  // Wrapper: split current selection into voltage/current and render both charts.
  function renderWaveforms() {
    const { voltageIdxs, currentIdxs } = splitSelectedAnalog();
    renderWaveformChart("voltage-waveform-plot", "voltage-waveform-empty", voltageIdxs);
    renderWaveformChart("current-waveform-plot", "current-waveform-empty", currentIdxs);
  }

  $("per-unit-toggle").addEventListener("change", renderWaveforms);

  $("show-points-toggle").addEventListener("change", function () {
    state.showPoints = this.checked;
    renderWaveforms();
    renderRmsCharts();
    renderDigital();
  });

  /* ---------------- seconds / cycles toggle ---------------- */

  function updateCyclesButton() {
    $("cycles-toggle").textContent = state.xInCycles ? "View in Seconds" : "View in Cycles";
  }

  $("cycles-toggle").addEventListener("click", () => {
    if (!state.record) return;
    const f = lineFreq();
    // Switching units: convert the stored shared range so the view stays put.
    if (state.xRange) {
      state.xRange = state.xInCycles
        ? [state.xRange[0] / f, state.xRange[1] / f]   // cycles -> seconds
        : [state.xRange[0] * f, state.xRange[1] * f];  // seconds -> cycles
    }
    state.xInCycles = !state.xInCycles;
    updateCyclesButton();
    renderWaveforms();
    renderRmsCharts();
    renderDigital();
  });

  /* ---------------- 1-cycle RMS vs time ---------------- */

  function oneCycleRms(values, sampleRate, lineFreq) {
    const N = Math.round(sampleRate / lineFreq);
    if (N < 2 || values.length < N) return null;
    const rms = new Float64Array(values.length - N + 1);
    // Compute first window sum-of-squares
    let ss = 0;
    for (let i = 0; i < N; i++) ss += values[i] * values[i];
    rms[0] = Math.sqrt(ss / N);
    // Slide the window
    for (let i = 1; i < rms.length; i++) {
      ss += values[i + N - 1] * values[i + N - 1] - values[i - 1] * values[i - 1];
      rms[i] = Math.sqrt(Math.max(0, ss) / N);
    }
    return rms;
  }

  function renderRmsChartFor(plotDivId, emptyHintId, channelIdxs) {
    const record = state.record;
    if (!record) return;
    const div = $(plotDivId);
    const idxs = channelIdxs;

    $(emptyHintId).classList.toggle("hidden", idxs.length > 0);
    if (idxs.length === 0) { Plotly.purge(div); div.innerHTML = ""; return; }

    const lineFreq = record.cfg.lineFrequency || 60;
    const N = Math.round(record.sampleRate / lineFreq);
    // Time axis starts half a cycle in (centre of first window)
    const timeRms = Array.from(record.time.slice(N - 1));

    const traces = idxs.map(i => {
      const ch = record.cfg.analogChannels[i];
      const rms = oneCycleRms(record.analog[i], record.sampleRate, lineFreq);
      if (!rms) return null;
      const d = decimate(timeRms, rms, MAX_PLOT_POINTS);
      return {
        x: toDisplayX(d.x), y: d.y,
        type: "scatter", mode: state.showPoints ? "lines+markers" : "lines",
        name: ch.name + (ch.phase ? ` (${ch.phase})` : "") + (ch.units ? ` [${ch.units}]` : ""),
        line: { color: analogColor(i, ch), width: 1.4 },
        marker: { size: 3 },
        hovertemplate: "%{y:.5g}" + (ch.units ? " " + ch.units : "") +
                       "<extra>" + escapeHtml(ch.name) + "</extra>"
      };
    }).filter(Boolean);

    if (!traces.length) { Plotly.purge(div); div.innerHTML = ""; return; }

    const units = new Set(idxs.map(i => record.cfg.analogChannels[i].units).filter(Boolean));
    const yTitle = units.size === 1 ? `RMS [${[...units][0]}]` : "RMS (mixed units)";

    const xRange = state.xRange ||
      toDisplayX([record.time[0], record.time[record.count - 1]]);
    Plotly.react(div, traces, darkLayout({
      xaxis: Object.assign(darkLayout().xaxis, { title: { text: xAxisLabel() }, range: xRange }),
      yaxis: Object.assign(darkLayout().yaxis, { title: { text: yTitle } }),
      legend: { orientation: "h", y: 1.12, font: { color: "#c8d2dc" } }
    }), PLOT_CONFIG);
  }

  // Wrapper: split current selection into voltage/current and render both RMS charts.
  function renderRmsCharts() {
    const { voltageIdxs, currentIdxs } = splitSelectedAnalog();
    renderRmsChartFor("voltage-rms-plot", "voltage-rms-empty", voltageIdxs);
    renderRmsChartFor("current-rms-plot", "current-rms-empty", currentIdxs);
  }

  /* ---------------- digital plot ---------------- */

  function renderDigital() {
    const record = state.record;
    if (!record) return;
    const card = $("digital-card");
    if (record.cfg.nDigital === 0) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");

    const div = $("digital-plot");
    const idxs = [...state.selectedDigital].sort((a, b) => a - b)
      .filter(i => i < record.cfg.nDigital);
    $("digital-empty").classList.toggle("hidden", idxs.length > 0);
    if (idxs.length === 0) { Plotly.purge(div); div.innerHTML = ""; return; }

    div.style.height = Math.max(180, 70 + idxs.length * 42) + "px";

    const time = record.time;
    const last = record.count - 1;
    const traces = [];
    const tickVals = [], tickText = [];

    idxs.forEach((chIdx, row) => {
      const ch = record.cfg.digitalChannels[chIdx];
      const v = record.digital[chIdx];
      const offset = (idxs.length - 1 - row) * 1.6;
      tickVals.push(offset + 0.5);
      tickText.push(ch.name);

      // Build explicit step points: only where the value changes.
      const xs = [time[0]], ys = [offset + v[0]];
      for (let i = 1; i <= last; i++) {
        if (v[i] !== v[i - 1]) {
          xs.push(time[i], time[i]);
          ys.push(offset + v[i - 1], offset + v[i]);
        }
      }
      xs.push(time[last]); ys.push(offset + v[last]);

      traces.push({
        x: toDisplayX(xs), y: ys,
        type: "scatter", mode: state.showPoints ? "lines+markers" : "lines",
        name: ch.name,
        line: { color: PALETTE[(chIdx + 2) % PALETTE.length], width: 1.8, shape: "linear" },
        marker: { size: 3 },
        hovertemplate: "%{customdata}<extra>" + escapeHtml(ch.name) + "</extra>",
        customdata: ys.map(y => (y - offset) >= 0.5 ? "ON (1)" : "OFF (0)"),
        showlegend: false
      });
    });

    const xRange = state.xRange || toDisplayX([record.time[0], record.time[record.count - 1]]);
    Plotly.react(div, traces, darkLayout({
      xaxis: Object.assign(darkLayout().xaxis, { title: { text: xAxisLabel() }, range: xRange }),
      yaxis: Object.assign(darkLayout().yaxis, {
        tickvals: tickVals, ticktext: tickText,
        range: [-0.6, (idxs.length - 1) * 1.6 + 1.6],
        zeroline: false, showgrid: false, fixedrange: true
      }),
      margin: { l: 80, r: 20, t: 10, b: 45 },
      hovermode: "closest"
    }), PLOT_CONFIG);
  }

  /* ---------------- FFT panel ---------------- */

  function populateFftChannels(record) {
    const sel = $("fft-channel");
    sel.innerHTML = "";
    record.cfg.analogChannels.forEach((ch, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${ch.name}${ch.units ? " [" + ch.units + "]" : ""}`;
      sel.appendChild(opt);
    });
    sel.disabled = record.cfg.nAnalog === 0;
  }

  function renderFft() {
    const record = state.record;
    if (!record) return;
    const div = $("fft-plot");
    const note = $("fft-note");
    if (record.cfg.nAnalog === 0) {
      Plotly.purge(div); div.innerHTML = "";
      note.textContent = "No analog channels in this record.";
      return;
    }
    const i = parseInt($("fft-channel").value || "0", 10);
    const ch = record.cfg.analogChannels[i];

    let spec;
    try {
      spec = FFT.amplitudeSpectrum(record.analog[i], record.sampleRate);
    } catch (err) {
      Plotly.purge(div); div.innerHTML = "";
      note.textContent = "FFT unavailable: " + err.message;
      return;
    }

    const limit1k = $("fft-zoom").checked;
    const nyquist = record.sampleRate / 2;
    const fMax = limit1k ? Math.min(1000, nyquist) : nyquist;

    let endIdx = spec.freqs.length;
    while (endIdx > 1 && spec.freqs[endIdx - 1] > fMax) endIdx--;

    const x = Array.from(spec.freqs.slice(0, endIdx));
    const y = Array.from(spec.mags.slice(0, endIdx));
    const logScale = $("fft-log").checked;

    Plotly.react(div, [{
      x, y,
      type: "scatter", mode: "lines", fill: "tozeroy",
      fillcolor: "rgba(76,194,255,0.12)",
      line: { color: "#4cc2ff", width: 1.5 },
      hovertemplate: "%{x:.2f} Hz<br>%{y:.5g}" +
                     (ch.units ? " " + ch.units : "") + "<extra></extra>"
    }], darkLayout({
      xaxis: Object.assign(darkLayout().xaxis,
        { title: { text: "Frequency (Hz)" }, range: [0, fMax] }),
      yaxis: Object.assign(darkLayout().yaxis, {
        title: { text: `Amplitude${ch.units ? " (" + ch.units + ")" : ""}` },
        type: logScale ? "log" : "linear"
      }),
      hovermode: "closest",
      showlegend: false
    }), PLOT_CONFIG);

    const df = record.sampleRate / spec.n;
    note.textContent =
      `Hann window · ${spec.n}-point FFT @ ${fmt(record.sampleRate, 6)} Hz · ` +
      `resolution ${fmt(df, 4)} Hz · Nyquist ${fmt(nyquist, 6)} Hz` +
      (spec.n < record.count ? ` · analysed first ${spec.n} of ${record.count} samples` : "");
  }

  $("fft-channel").addEventListener("change", renderFft);
  $("fft-log").addEventListener("change", renderFft);
  $("fft-zoom").addEventListener("change", renderFft);

  /* ---------------- statistics table ---------------- */

  function renderStats(record) {
    const tbody = $("stats-table").querySelector("tbody");
    tbody.innerHTML = "";
    record.cfg.analogChannels.forEach((ch, i) => {
      const s = Comtrade.channelStats(record.analog[i], record.time);
      const tr = document.createElement("tr");
      const cells = [
        String(i + 1),
        ch.name,
        ch.phase || "—",
        ch.units || "—",
        fmt(s.rms, 5),
        fmt(s.peak, 5),
        fmt(s.min, 5),
        fmt(s.max, 5),
        fmt(s.mean, 4),
        Number.isFinite(s.freq) ? fmt(s.freq, 4) : "—"
      ];
      cells.forEach((text, c) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (c === 1) td.className = "chan-cell";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  /* ---------------- axis sync ---------------- */

  function axisRangeFrom(data) {
    if (data["xaxis.range[0]"] !== undefined && data["xaxis.range[1]"] !== undefined)
      return [data["xaxis.range[0]"], data["xaxis.range[1]"]];
    if (data["xaxis.range"] && data["xaxis.range"].length === 2)
      return data["xaxis.range"];
    return null;
  }

  function setupAxisSync() {
    const DEBOUNCE = 150;

    const allDivs = [
      $("voltage-waveform-plot"),
      $("voltage-rms-plot"),
      $("current-waveform-plot"),
      $("current-rms-plot"),
      $("digital-plot")
    ];
    allDivs.forEach(d => { if (d.removeAllListeners) d.removeAllListeners("plotly_relayout"); });

    function syncOthers(sourceDiv, r) {
      state.xRange = r;
      state.lastSyncMs = Date.now();
      allDivs.filter(d => d !== sourceDiv && d.data)
        .forEach(d => Plotly.relayout(d, { "xaxis.range[0]": r[0], "xaxis.range[1]": r[1] }));
    }

    allDivs.forEach(div => {
      if (!div.on) return;
      div.on("plotly_relayout", data => {
        if (Date.now() - state.lastSyncMs < DEBOUNCE) return;
        const r = axisRangeFrom(data);
        if (!r) return;
        syncOthers(div, r);
      });
    });
  }

  /* ---------------- utilities ---------------- */

  function fmt(v, sig) {
    if (!Number.isFinite(v)) return "—";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e6 || a < 1e-3) return v.toExponential(Math.max(0, sig - 1));
    return String(Number(v.toPrecision(sig)));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g,
      c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------------- demo record ---------------- */

  function buildDemoRecord() {
    const fs = 4800;             // 80 samples/cycle at 60 Hz
    const f0 = 60;
    const dur = 0.3;
    const n = Math.round(fs * dur);
    const tFault = 0.1, tTrip = 0.155, tBreaker = 0.205;

    const cfgText = [
      "DEMO SUBSTATION,REL-DEMO-1,1999",
      "8,6A,2D",
      "1,VA,A,,kV,0.01,0,0,-32767,32767,115000,115,P",
      "2,VB,B,,kV,0.01,0,0,-32767,32767,115000,115,P",
      "3,VC,C,,kV,0.01,0,0,-32767,32767,115000,115,P",
      "4,IA,A,,A,0.25,0,0,-32767,32767,1200,5,P",
      "5,IB,B,,A,0.25,0,0,-32767,32767,1200,5,P",
      "6,IC,C,,A,0.25,0,0,-32767,32767,1200,5,P",
      "1,TRIP,,,0",
      "2,BREAKER 52A,,,1",
      "60",
      "1",
      `${fs},${n}`,
      "12/06/2026,10:15:30.000000",
      "12/06/2026,10:15:30.100000",
      "ASCII",
      "1"
    ].join("\n");

    const w = 2 * Math.PI * f0;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const faulted = t >= tFault && t < tBreaker;
      const open = t >= tBreaker;

      // Voltages (kV peak ~93.9 = 115kV LL nominal): phase A sags during fault.
      const vMagA = faulted ? 45 : 93.9;
      const va = vMagA * Math.sin(w * t);
      const vb = 93.9 * Math.sin(w * t - 2 * Math.PI / 3) * (faulted ? 0.96 : 1);
      const vc = 93.9 * Math.sin(w * t + 2 * Math.PI / 3) * (faulted ? 0.97 : 1);

      // Currents: A-phase fault with decaying DC offset + harmonics, breaker clears.
      let ia, ib, ic;
      if (open) {
        ia = 0; ib = 0; ic = 0;
      } else if (faulted) {
        const tf = t - tFault;
        ia = 2800 * Math.sin(w * t - 1.2)
           + 1900 * Math.exp(-tf / 0.045)
           + 260 * Math.sin(3 * w * t)
           + 130 * Math.sin(5 * w * t);
        ib = 420 * Math.sin(w * t - 2 * Math.PI / 3 - 0.5);
        ic = 410 * Math.sin(w * t + 2 * Math.PI / 3 - 0.5);
      } else {
        ia = 380 * Math.sin(w * t - 0.35);
        ib = 380 * Math.sin(w * t - 2 * Math.PI / 3 - 0.35);
        ic = 380 * Math.sin(w * t + 2 * Math.PI / 3 - 0.35);
      }

      const noise = () => (Math.random() - 0.5) * 1.2;
      // Convert to raw counts (inverse of the cfg scaling a, b).
      const raw = [
        Math.round(va / 0.01), Math.round(vb / 0.01), Math.round(vc / 0.01),
        Math.round((ia + noise()) / 0.25),
        Math.round((ib + noise()) / 0.25),
        Math.round((ic + noise()) / 0.25)
      ].map(v => Math.max(-32767, Math.min(32767, v)));

      const trip = t >= tTrip ? 1 : 0;
      const breaker = open ? 0 : 1;
      rows.push(`${i + 1},${Math.round(t * 1e6)},${raw.join(",")},${trip},${breaker}`);
    }
    return { cfgText, datText: rows.join("\n") };
  }

  $("demo-btn").addEventListener("click", () => {
    try {
      clearMessage();
      const demo = buildDemoRecord();
      const cfg = Comtrade.parseCfg(demo.cfgText);
      const record = Comtrade.parseRecord(cfg, demo.datText);
      record.sourceName = "demo-fault";
      state.pendingCfg = null;
      state.pendingDat = null;
      updateSlot("slot-cfg", "slot-cfg-name", null);
      updateSlot("slot-dat", "slot-dat-name", null);
      presentRecord(record);
    } catch (err) {
      console.error(err);
      showError("Demo failed: " + err.message);
    }
  });

})();
