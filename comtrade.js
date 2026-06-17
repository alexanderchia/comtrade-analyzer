/* ============================================================
 * comtrade.js — IEEE C37.111 / IEC 60255-24 Comtrade parser
 * Supports revisions 1991, 1999, 2013.
 * Data formats: ASCII, BINARY (int16), BINARY32 (int32), FLOAT32.
 * No external dependencies.
 * ============================================================ */
"use strict";

const Comtrade = (() => {

  class ComtradeError extends Error {
    constructor(msg) { super(msg); this.name = "ComtradeError"; }
  }

  const SUPPORTED_REVISIONS = [1991, 1999, 2013];

  /* ----------------------------------------------------------
   * CFG parsing
   * ---------------------------------------------------------- */

  function splitCsv(line) {
    return line.split(",").map(s => s.trim());
  }

  function toNumber(str, what, lineNo, fallback) {
    if (str === undefined || str === "") {
      if (fallback !== undefined) return fallback;
      throw new ComtradeError(`CFG line ${lineNo}: missing ${what}`);
    }
    const v = Number(str);
    if (!Number.isFinite(v)) {
      if (fallback !== undefined) return fallback;
      throw new ComtradeError(`CFG line ${lineNo}: invalid ${what}: "${str}"`);
    }
    return v;
  }

  /**
   * Parse a .cfg file (text).
   * Returns a config object describing the record.
   */
  function parseCfg(text) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new ComtradeError("CFG file is empty.");
    }
    const rawLines = text.split(/\r\n|\n|\r/);
    // Trim trailing blank lines but keep internal positions intact.
    while (rawLines.length && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();

    let li = 0; // zero-based index into rawLines
    const nextLine = (what) => {
      if (li >= rawLines.length) {
        throw new ComtradeError(`CFG file ended early — expected ${what} on line ${li + 1}.`);
      }
      return rawLines[li++];
    };

    // ---- line 1: station_name, rec_dev_id [, rev_year] ----
    const l1 = splitCsv(nextLine("station name / device id"));
    const cfg = {
      stationName: l1[0] || "(unnamed)",
      deviceId: l1[1] || "",
      revision: 1991
    };
    if (l1.length >= 3 && l1[2] !== "") {
      const ry = parseInt(l1[2], 10);
      if (!Number.isFinite(ry)) {
        throw new ComtradeError(`CFG line 1: invalid revision year "${l1[2]}".`);
      }
      if (!SUPPORTED_REVISIONS.includes(ry)) {
        throw new ComtradeError(
          `Unsupported Comtrade revision year: ${ry}. Supported: 1991, 1999, 2013.`);
      }
      cfg.revision = ry;
    }

    // ---- line 2: TT, ##A, ##D ----
    const l2 = splitCsv(nextLine("channel counts (TT,##A,##D)"));
    if (l2.length < 3) {
      throw new ComtradeError(`CFG line 2: expected "TT,##A,##D", got "${rawLines[1]}".`);
    }
    const mA = /^(\d+)\s*A$/i.exec(l2[1]);
    const mD = /^(\d+)\s*D$/i.exec(l2[2]);
    if (!mA || !mD) {
      throw new ComtradeError(`CFG line 2: cannot parse channel counts from "${rawLines[1]}".`);
    }
    cfg.totalChannels = toNumber(l2[0], "total channel count", 2);
    cfg.nAnalog = parseInt(mA[1], 10);
    cfg.nDigital = parseInt(mD[1], 10);
    if (cfg.totalChannels !== cfg.nAnalog + cfg.nDigital) {
      // Some files get TT wrong; trust the A/D counts but note it.
      cfg.countMismatchWarning =
        `CFG declares TT=${cfg.totalChannels} but ${cfg.nAnalog}A + ${cfg.nDigital}D = ` +
        `${cfg.nAnalog + cfg.nDigital}. Using the A/D counts.`;
    }
    if (cfg.nAnalog + cfg.nDigital === 0) {
      throw new ComtradeError("CFG declares zero channels — nothing to display.");
    }

    // ---- analog channel definitions ----
    cfg.analogChannels = [];
    for (let i = 0; i < cfg.nAnalog; i++) {
      const lineNo = li + 1;
      const f = splitCsv(nextLine(`analog channel definition ${i + 1}`));
      if (f.length < 10) {
        throw new ComtradeError(
          `CFG line ${lineNo}: analog channel needs at least 10 fields ` +
          `(An,id,ph,ccbm,uu,a,b,skew,min,max), got ${f.length}.`);
      }
      cfg.analogChannels.push({
        index: toNumber(f[0], "analog channel index", lineNo, i + 1),
        name: f[1] || `Analog ${i + 1}`,
        phase: f[2] || "",
        component: f[3] || "",
        units: f[4] || "",
        a: toNumber(f[5], "multiplier a", lineNo),
        b: toNumber(f[6], "offset b", lineNo, 0),
        skew: toNumber(f[7], "skew", lineNo, 0),
        min: toNumber(f[8], "min", lineNo, -32767),
        max: toNumber(f[9], "max", lineNo, 32767),
        primary: f.length > 10 ? toNumber(f[10], "primary", lineNo, 1) : 1,
        secondary: f.length > 11 ? toNumber(f[11], "secondary", lineNo, 1) : 1,
        ps: f.length > 12 && f[12] !== "" ? f[12].toUpperCase() : "S"
      });
    }

    // ---- digital channel definitions ----
    cfg.digitalChannels = [];
    for (let i = 0; i < cfg.nDigital; i++) {
      const lineNo = li + 1;
      const f = splitCsv(nextLine(`digital channel definition ${i + 1}`));
      if (f.length < 2) {
        throw new ComtradeError(
          `CFG line ${lineNo}: digital channel needs at least 2 fields (Dn,id), got ${f.length}.`);
      }
      // 1991:        Dn, ch_id, y
      // 1999 / 2013: Dn, ch_id, ph, ccbm, y
      const isLong = f.length >= 5;
      const normField = isLong ? f[4] : (f.length >= 3 ? f[2] : "0");
      cfg.digitalChannels.push({
        index: toNumber(f[0], "digital channel index", lineNo, i + 1),
        name: f[1] || `Digital ${i + 1}`,
        phase: isLong ? (f[2] || "") : "",
        component: isLong ? (f[3] || "") : "",
        normalState: normField === "1" ? 1 : 0
      });
    }

    // ---- line frequency ----
    cfg.lineFrequency = toNumber(splitCsv(nextLine("line frequency"))[0],
                                 "line frequency", li, 0);

    // ---- sample rates ----
    const nratesLine = li + 1;
    cfg.nrates = Math.trunc(toNumber(splitCsv(nextLine("nrates"))[0], "nrates", nratesLine));
    if (cfg.nrates < 0 || cfg.nrates > 1000) {
      throw new ComtradeError(`CFG line ${nratesLine}: implausible nrates value ${cfg.nrates}.`);
    }
    cfg.sampleRates = [];
    const rateLines = Math.max(cfg.nrates, 1); // nrates==0 still has one samp,endsamp line
    for (let i = 0; i < rateLines; i++) {
      const lineNo = li + 1;
      const f = splitCsv(nextLine(`sample rate ${i + 1} (samp,endsamp)`));
      if (f.length < 2) {
        throw new ComtradeError(`CFG line ${lineNo}: expected "samp,endsamp".`);
      }
      cfg.sampleRates.push({
        samp: toNumber(f[0], "samp", lineNo),
        endsamp: Math.trunc(toNumber(f[1], "endsamp", lineNo))
      });
    }
    cfg.totalSamples = cfg.sampleRates[cfg.sampleRates.length - 1].endsamp;
    if (!Number.isFinite(cfg.totalSamples) || cfg.totalSamples <= 0) {
      throw new ComtradeError("CFG: last endsamp must be a positive sample count.");
    }

    // ---- timestamps: first data point, trigger point ----
    // Each is "dd/mm/yyyy,hh:mm:ss.ssssss" (the comma is part of the line).
    cfg.startTime = nextLine("first-sample date/time").trim();
    cfg.triggerTime = nextLine("trigger date/time").trim();

    // ---- data file type ----
    const ftRaw = nextLine("data file type (ft)").trim().toUpperCase();
    const ft = splitCsv(ftRaw)[0];
    if (!["ASCII", "BINARY", "BINARY32", "FLOAT32"].includes(ft)) {
      throw new ComtradeError(
        `Unsupported data file type "${ftRaw}". Expected ASCII, BINARY, BINARY32 or FLOAT32.`);
    }
    cfg.fileType = ft;

    // ---- timemult (1999+) ----
    cfg.timeMult = 1;
    if (li < rawLines.length) {
      const tm = parseFloat(splitCsv(rawLines[li])[0]);
      if (Number.isFinite(tm) && tm > 0) cfg.timeMult = tm;
      li++;
    }
    // 2013 may append "time_code,local_code" and "tmq_code,leapsec" lines — informational only.
    cfg.extraLines = rawLines.slice(li).filter(l => l.trim() !== "");

    return cfg;
  }

  /* ----------------------------------------------------------
   * Timestamp helpers
   * ---------------------------------------------------------- */

  // Parse a Comtrade timestamp string "dd/mm/yyyy,hh:mm:ss.ssssss" → seconds (Unix epoch).
  function parseTimestamp(s) {
    if (!s) return NaN;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s.trim());
    if (!m) return NaN;
    const fracSec = m[7] ? parseFloat("0." + m[7]) : 0;
    return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]) / 1000 + fracSec;
  }

  /* ----------------------------------------------------------
   * Time axis from CFG sample-rate table
   * ---------------------------------------------------------- */

  /** True if the rate table can fully describe the time axis. */
  function hasUsableRates(cfg) {
    return cfg.nrates >= 1 && cfg.sampleRates.every(r => r.samp > 0);
  }

  function timeAxisFromRates(cfg, count) {
    const t = new Float64Array(count);
    let seg = 0;
    let time = 0;
    for (let n = 0; n < count; n++) {
      t[n] = time;
      while (seg < cfg.sampleRates.length - 1 && n + 1 >= cfg.sampleRates[seg].endsamp) seg++;
      time += 1 / cfg.sampleRates[seg].samp;
    }
    return t;
  }

  /* ----------------------------------------------------------
   * DAT parsing — ASCII
   * ---------------------------------------------------------- */

  function parseDatAscii(text, cfg) {
    const nA = cfg.nAnalog, nD = cfg.nDigital;
    const expectedCols = 2 + nA + nD;

    const lines = text.split(/\r\n|\n|\r/);
    const rows = [];
    for (const line of lines) {
      if (line.trim() !== "") rows.push(line);
    }
    if (rows.length === 0) throw new ComtradeError("DAT file (ASCII) contains no data rows.");

    const count = rows.length;
    const analog = [];
    for (let c = 0; c < nA; c++) analog.push(new Float64Array(count));
    const digital = [];
    for (let c = 0; c < nD; c++) digital.push(new Uint8Array(count));
    const timestamps = new Float64Array(count);
    let timestampsValid = true;

    for (let r = 0; r < count; r++) {
      const f = rows[r].split(",");
      if (f.length !== expectedCols) {
        throw new ComtradeError(
          `DAT row ${r + 1}: expected ${expectedCols} columns ` +
          `(n, timestamp, ${nA} analog, ${nD} digital) but found ${f.length}. ` +
          `The .dat file may not match this .cfg.`);
      }
      const ts = f[1].trim();
      if (ts === "") {
        timestampsValid = false;
      } else {
        const tv = Number(ts);
        if (!Number.isFinite(tv)) timestampsValid = false;
        else timestamps[r] = tv;
      }
      for (let c = 0; c < nA; c++) {
        const s = f[2 + c].trim();
        if (s === "" || /^9{4,}$/.test(s)) { // blank = missing
          analog[c][r] = NaN;
          continue;
        }
        const v = Number(s);
        if (!Number.isFinite(v)) {
          throw new ComtradeError(
            `DAT row ${r + 1}, analog channel ${c + 1}: invalid value "${s}".`);
        }
        const ch = cfg.analogChannels[c];
        analog[c][r] = v * ch.a + ch.b;
      }
      for (let c = 0; c < nD; c++) {
        const s = f[2 + nA + c].trim();
        digital[c][r] = (s === "1") ? 1 : 0;
      }
    }
    return { count, analog, digital, timestamps, timestampsValid };
  }

  /* ----------------------------------------------------------
   * DAT parsing — BINARY / BINARY32 / FLOAT32
   * ---------------------------------------------------------- */

  function parseDatBinary(buffer, cfg) {
    const nA = cfg.nAnalog, nD = cfg.nDigital;
    const analogBytes = cfg.fileType === "BINARY" ? 2 : 4;
    const digitalWords = Math.ceil(nD / 16);
    const recordLen = 4 + 4 + nA * analogBytes + digitalWords * 2;

    const view = new DataView(buffer);
    if (buffer.byteLength < recordLen) {
      throw new ComtradeError(
        `DAT file (binary) is smaller than one sample record (${recordLen} bytes). ` +
        `The .dat file may not match this .cfg, or it may actually be ASCII.`);
    }
    if (buffer.byteLength % recordLen !== 0) {
      throw new ComtradeError(
        `DAT file size (${buffer.byteLength} bytes) is not a whole number of ` +
        `${recordLen}-byte records (${nA} analog + ${nD} digital channels). ` +
        `The .dat file probably does not match this .cfg.`);
    }

    const count = buffer.byteLength / recordLen;
    const analog = [];
    for (let c = 0; c < nA; c++) analog.push(new Float64Array(count));
    const digital = [];
    for (let c = 0; c < nD; c++) digital.push(new Uint8Array(count));
    const timestamps = new Float64Array(count);
    let timestampsValid = true;

    for (let r = 0; r < count; r++) {
      let off = r * recordLen;
      off += 4; // sample number (uint32 LE) — recomputed, not trusted
      const ts = view.getUint32(off, true);
      off += 4;
      if (ts === 0xFFFFFFFF) timestampsValid = false;
      else timestamps[r] = ts;

      for (let c = 0; c < nA; c++) {
        let raw;
        if (cfg.fileType === "BINARY") {
          raw = view.getInt16(off, true);
          off += 2;
          if (raw === -32768) { analog[c][r] = NaN; continue; } // 0x8000 = missing
        } else if (cfg.fileType === "BINARY32") {
          raw = view.getInt32(off, true);
          off += 4;
          if (raw === -2147483648) { analog[c][r] = NaN; continue; }
        } else { // FLOAT32
          raw = view.getFloat32(off, true);
          off += 4;
          if (!Number.isFinite(raw)) { analog[c][r] = NaN; continue; }
        }
        const ch = cfg.analogChannels[c];
        analog[c][r] = raw * ch.a + ch.b;
      }

      for (let w = 0; w < digitalWords; w++) {
        const word = view.getUint16(off, true);
        off += 2;
        const base = w * 16;
        const limit = Math.min(16, nD - base);
        for (let b = 0; b < limit; b++) {
          digital[base + b][r] = (word >> b) & 1;
        }
      }
    }
    return { count, analog, digital, timestamps, timestampsValid };
  }

  /* ----------------------------------------------------------
   * Top-level record assembly
   * ---------------------------------------------------------- */

  /**
   * Build a complete record from parsed cfg + raw dat content.
   * @param {object} cfg          result of parseCfg
   * @param {string|ArrayBuffer}  datContent text for ASCII, ArrayBuffer for binary
   */
  function parseRecord(cfg, datContent) {
    let data;
    if (cfg.fileType === "ASCII") {
      if (typeof datContent !== "string") {
        throw new ComtradeError("Internal error: ASCII .dat must be read as text.");
      }
      data = parseDatAscii(datContent, cfg);
    } else {
      if (!(datContent instanceof ArrayBuffer)) {
        throw new ComtradeError("Internal error: binary .dat must be read as ArrayBuffer.");
      }
      data = parseDatBinary(datContent, cfg);
    }

    const warnings = [];
    if (cfg.countMismatchWarning) warnings.push(cfg.countMismatchWarning);
    if (data.count !== cfg.totalSamples) {
      warnings.push(
        `CFG declares ${cfg.totalSamples} samples but the DAT file contains ${data.count}. ` +
        `Showing the ${data.count} samples found.`);
    }

    // ---- time axis (seconds, relative to first sample) ----
    let time;
    let effectiveRate; // representative sample rate in Hz (for FFT)
    if (hasUsableRates(cfg)) {
      time = timeAxisFromRates(cfg, data.count);
      effectiveRate = cfg.sampleRates[0].samp;
      if (cfg.sampleRates.length > 1) {
        warnings.push(
          `Record uses ${cfg.sampleRates.length} sample-rate segments; ` +
          `FFT uses the first segment's rate (${effectiveRate} Hz).`);
      }
    } else {
      if (!data.timestampsValid) {
        throw new ComtradeError(
          "CFG specifies no fixed sample rate (nrates=0 or samp=0) and the DAT " +
          "timestamps are missing — the time axis cannot be reconstructed.");
      }
      // DAT timestamps are microseconds × timemult
      time = new Float64Array(data.count);
      const t0 = data.timestamps[0];
      for (let i = 0; i < data.count; i++) {
        time[i] = (data.timestamps[i] - t0) * cfg.timeMult * 1e-6;
      }
      const span = time[data.count - 1] - time[0];
      if (data.count > 1 && span > 0) {
        effectiveRate = (data.count - 1) / span;
      } else {
        throw new ComtradeError("DAT timestamps do not increase — cannot build a time axis.");
      }
    }

    // Trigger offset: seconds from first sample to trigger event.
    const tsStart = parseTimestamp(cfg.startTime);
    const tsTrig  = parseTimestamp(cfg.triggerTime);
    const triggerOffset = (Number.isFinite(tsStart) && Number.isFinite(tsTrig) && tsTrig >= tsStart)
      ? tsTrig - tsStart
      : NaN;

    return {
      cfg,
      count: data.count,
      time,                       // Float64Array, seconds from first sample
      analog: data.analog,        // Float64Array per channel (scaled, engineering units)
      digital: data.digital,      // Uint8Array per channel
      sampleRate: effectiveRate,  // Hz
      duration: data.count > 1 ? time[data.count - 1] - time[0] : 0,
      triggerOffset,              // seconds from first sample, NaN if unavailable
      warnings
    };
  }

  /* ----------------------------------------------------------
   * Channel statistics
   * ---------------------------------------------------------- */

  /**
   * RMS / peak / min / max / mean / estimated frequency for one channel.
   * Frequency is estimated from positive-going zero crossings of the
   * mean-removed signal, with linear interpolation between samples.
   */
  function channelStats(values, time) {
    let min = Infinity, max = -Infinity, sum = 0, sumSq = 0, n = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sumSq += v * v;
      n++;
    }
    if (n === 0) {
      return { rms: NaN, peak: NaN, min: NaN, max: NaN, mean: NaN, freq: NaN };
    }
    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);
    const peak = Math.max(Math.abs(min), Math.abs(max));

    // zero-crossing frequency estimate
    let firstT = NaN, lastT = NaN, crossings = 0;
    let prev = NaN, prevT = NaN;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) { prev = NaN; continue; }
      const y = v - mean;
      if (Number.isFinite(prev) && prev < 0 && y >= 0) {
        const frac = prev === y ? 0 : -prev / (y - prev);
        const tc = prevT + frac * (time[i] - prevT);
        if (Number.isNaN(firstT)) firstT = tc;
        else { lastT = tc; crossings++; }
      }
      prev = y;
      prevT = time[i];
    }
    let freq = NaN;
    if (crossings >= 1 && lastT > firstT) {
      freq = crossings / (lastT - firstT);
    }
    return { rms, peak, min, max, mean, freq };
  }

  /* ----------------------------------------------------------
   * CFF (Combined File Format) — IEEE C37.111-2013
   * A single .cff file contains CFG and DAT sections delimited
   * by "--- file type: <NAME> ---" header lines.
   * ---------------------------------------------------------- */

  function parseCff(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new ComtradeError("parseCff requires an ArrayBuffer.");
    }
    const bytes = new Uint8Array(buffer);
    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8");

    function findBytes(needle, from) {
      const nb = enc.encode(needle);
      outer: for (let i = from, end = bytes.length - nb.length; i <= end; i++) {
        for (let j = 0; j < nb.length; j++) {
          if (bytes[i + j] !== nb[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    // Returns byte offset of first content byte after the named section header.
    function sectionStart(name, from) {
      const marker = `--- file type: ${name} ---`;
      const off = findBytes(marker, from);
      if (off === -1) return -1;
      let end = off + marker.length;
      if (bytes[end] === 0x0D && bytes[end + 1] === 0x0A) end += 2;
      else if (bytes[end] === 0x0A) end += 1;
      return end;
    }

    const cfgStart = sectionStart("CFG", 0);
    if (cfgStart === -1) {
      throw new ComtradeError(
        "Not a valid CFF file: missing '--- file type: CFG ---' section header.");
    }

    const datMarkerOff = findBytes("--- file type: DAT ---", cfgStart);
    if (datMarkerOff === -1) {
      throw new ComtradeError("CFF file: missing '--- file type: DAT ---' section header.");
    }
    const datStart = sectionStart("DAT", datMarkerOff);

    const cfgText = dec.decode(bytes.slice(cfgStart, datMarkerOff));
    const cfg = parseCfg(cfgText);

    // DAT ends at the next section marker or EOF
    const nextMarkerOff = findBytes("--- file type:", datStart);
    const datEnd = nextMarkerOff === -1 ? bytes.length : nextMarkerOff;

    const datContent = cfg.fileType === "ASCII"
      ? dec.decode(bytes.slice(datStart, datEnd))
      : buffer.slice(datStart, datEnd);

    return parseRecord(cfg, datContent);
  }

  return {
    ComtradeError,
    parseCfg,
    parseRecord,
    channelStats,
    parseCff
  };
})();
