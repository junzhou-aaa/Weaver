#!/usr/bin/env node
/**
 * Nature Orb — FFT Analysis & Key Score Generator
 *
 * Reads audio/merged.wav, performs frame-by-frame FFT analysis,
 * detects dominant frequency bands over time, and generates
 * a structured key-event score → audio/events.json
 *
 * Usage:  node analyze.js
 * Output: audio/events.json
 */

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const IN_WAV  = path.join(__dirname, 'audio', 'merged.wav');
const OUT_JSON = path.join(__dirname, 'audio', 'events.json');

const SAMPLE_RATE = 44100;

// FFT settings
const FFT_SIZE = 2048;   // window size — freq resolution = 44100/2048 ≈ 21.5 Hz
const HOP_SIZE = 512;    // hop between frames ≈ 11.6 ms → ~86 frames/sec

// Smoothing
const SMOOTH_MS = 250;   // temporal smoothing window (ms)

// Event generation constraints
const MIN_EVENT_DUR  = 1.0;   // minimum event hold duration (s)
const MAX_EVENT_DUR  = 3.5;   // maximum event hold duration (s)
const MIN_GAP        = 0.4;   // minimum free-play gap between events (s)
const RELEASE_WIN    = 0.3;   // ± tolerance for key release (s)
const FADE_IN_END    = 1.2;   // don't start events before this (s)
let FADE_OUT_START   = 28.0;  // don't start events after this (s)
const DUAL_RATIO     = 0.72;  // 2nd band must be ≥ this fraction of 1st → dual-key

// Sliding-window segmentation params
const SEG_WINDOW_MS  = 1500;  // analysis window size (ms) — one 'segment'
const SEG_HOP_MS     = 800;   // hop between candidate segment starts (ms)
const BAND_CHANGE_THRESH = 0.15; // min normalised energy difference to treat bands as different

// Frequency band definitions
const KEYS = ['S', 'D', 'F', 'J', 'K', 'L'];
const BANDS = [
  { key: KEYS[0], label: 'Low',    freqLow:   80, freqHigh:  250, color: '#C53030' },
  { key: KEYS[1], label: 'MidLow', freqLow:  250, freqHigh:  500, color: '#DD6B20' },
  { key: KEYS[2], label: 'Mid',    freqLow:  500, freqHigh: 1000, color: '#D69E2E' },
  { key: KEYS[3], label: 'MidHi',  freqLow: 1000, freqHigh: 2000, color: '#276749' },
  { key: KEYS[4], label: 'High',   freqLow: 2000, freqHigh: 5000, color: '#2B6CB0' },
  { key: KEYS[5], label: 'Ultra',  freqLow: 5000, freqHigh:16000, color: '#553C9A' },
];

// ── WAV Reader → mono Float32Array ────────────────────────────────────────────

function readWAVMono(filePath) {
  const buf  = fs.readFileSync(filePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not RIFF');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not WAVE');

  let offset = 12, fmt = null, dataOffset = 0, dataSize = 0;

  while (offset < buf.length - 8) {
    const chunkId   = buf.toString('ascii', offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkId === 'fmt ') {
      fmt = {
        audioFmt:     view.getUint16(offset,      true),
        numChannels:  view.getUint16(offset + 2,  true),
        sampleRate:   view.getUint32(offset + 4,  true),
        bitsPerSample:view.getUint16(offset + 14, true),
      };
    } else if (chunkId === 'data') {
      dataOffset = offset; dataSize = chunkSize; break;
    }
    offset += chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new Error('No fmt chunk');

  const bps         = fmt.bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / bps / fmt.numChannels);
  const mono        = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    let sum = 0;
    for (let ch = 0; ch < fmt.numChannels; ch++) {
      const pos = dataOffset + (i * fmt.numChannels + ch) * bps;
      let s;
      switch (fmt.bitsPerSample) {
        case  8: s = (buf[pos] - 128) / 128.0; break;
        case 16: s = view.getInt16(pos, true) / 32768.0; break;
        case 24: {
          let v = (buf[pos+2]<<16)|(buf[pos+1]<<8)|buf[pos];
          if (v >= 0x800000) v -= 0x1000000;
          s = v / 8388608.0; break;
        }
        case 32: s = view.getInt32(pos, true) / 2147483648.0; break;
        default: s = 0;
      }
      sum += s;
    }
    mono[i] = sum / fmt.numChannels;
  }

  return { mono, sampleRate: fmt.sampleRate, totalSamples };
}

// ── Hann Window ───────────────────────────────────────────────────────────────

function makeHannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return w;
}

// ── FFT (Cooley-Tukey Radix-2 DIT, in-place) ─────────────────────────────────
//
// re[] and im[] are the real and imaginary parts of the input (length = power of 2).
// After the call, re[k] and im[k] hold the k-th complex DFT coefficient.
// Only the first N/2 bins are meaningful (positive frequencies).

function fft(re, im) {
  const n = re.length;

  // Bit-reversal permutation:
  // Reorders samples so that each is placed at the position
  // whose binary representation is the bit-reversal of its original index.
  // This allows the butterfly stages to work in-place.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterfly stages:
  // At each stage, pairs of complex numbers are combined using twiddle factors
  // (complex roots of unity e^(-2πi k/len)) to build up the full DFT.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);  // base twiddle factor

    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;  // w^k (starts at w^0 = 1)

      for (let k = 0; k < (len >> 1); k++) {
        const a = i + k, b = i + k + (len >> 1);

        // Butterfly: [a, b] → [a + w*b, a - w*b]
        const uRe = re[a], uIm = im[a];
        const vRe = re[b]*curRe - im[b]*curIm;
        const vIm = re[b]*curIm + im[b]*curRe;

        re[a] = uRe + vRe;  im[a] = uIm + vIm;
        re[b] = uRe - vRe;  im[b] = uIm - vIm;

        // Advance twiddle factor: w^(k+1) = w^k × w
        const nRe = curRe*wRe - curIm*wIm;
        curIm     = curRe*wIm + curIm*wRe;
        curRe     = nRe;
      }
    }
  }
}

// ── Band Power Computation ────────────────────────────────────────────────────
//
// Returns the average power (energy density) of the magnitude spectrum
// within a given frequency range [freqLo, freqHi] Hz.
// Using average rather than sum normalises against band width differences.

function bandPower(mag, freqLo, freqHi, sr, fftSize) {
  const lo = Math.max(1, Math.ceil(freqLo  * fftSize / sr));
  const hi = Math.min(mag.length - 1, Math.floor(freqHi * fftSize / sr));
  if (hi < lo) return 0;
  let sum = 0;
  for (let b = lo; b <= hi; b++) sum += mag[b] * mag[b];
  return sum / (hi - lo + 1);
}

// ── Frame-by-Frame FFT Analysis ───────────────────────────────────────────────

function analyzeFrames(mono) {
  const hann      = makeHannWindow(FFT_SIZE);
  const re        = new Float64Array(FFT_SIZE);
  const im        = new Float64Array(FFT_SIZE);
  const numFrames = Math.floor((mono.length - FFT_SIZE) / HOP_SIZE) + 1;
  const frames    = [];          // [{time, energies:[6]}]

  process.stdout.write(`  Running FFT on ${numFrames} frames`);
  const reportEvery = Math.floor(numFrames / 20);

  for (let f = 0; f < numFrames; f++) {
    if (f % reportEvery === 0) process.stdout.write('.');

    const start = f * HOP_SIZE;

    // Fill FFT buffers with windowed samples
    re.fill(0); im.fill(0);
    for (let i = 0; i < FFT_SIZE && start + i < mono.length; i++) {
      re[i] = mono[start + i] * hann[i];
    }

    fft(re, im);

    // Compute magnitude spectrum (only positive frequencies: bins 0 … N/2-1)
    const mag = new Float32Array(FFT_SIZE >> 1);
    for (let i = 0; i < FFT_SIZE >> 1; i++) {
      mag[i] = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
    }

    // Compute energy in each of the 6 bands
    const energies = BANDS.map(b => bandPower(mag, b.freqLow, b.freqHigh, SAMPLE_RATE, FFT_SIZE));
    frames.push({ time: start / SAMPLE_RATE, energies });
  }

  console.log(' done');
  return frames;
}

// ── Temporal Smoothing ────────────────────────────────────────────────────────
//
// Applies a causal moving-average filter to the band energy time series.
// This removes rapid transient fluctuations so the dominant-band assignment
// reflects the sustained spectral character of each segment rather than
// individual percussion hits or brief noise bursts.

function smoothEnergies(frames) {
  const winFrames = Math.max(1, Math.round(SMOOTH_MS / 1000 * SAMPLE_RATE / HOP_SIZE));
  return frames.map((_, fi) => {
    const s = Math.max(0, fi - Math.floor(winFrames / 2));
    const e = Math.min(frames.length, fi + Math.ceil(winFrames / 2));
    const smoothed = new Array(BANDS.length).fill(0);
    for (let f = s; f < e; f++) {
      for (let b = 0; b < BANDS.length; b++) smoothed[b] += frames[f].energies[b];
    }
    const count = e - s;
    return { time: frames[fi].time, energies: smoothed.map(v => v / count) };
  });
}

// ── Per-Band Mean Normalization (Option B) ────────────────────────────────────
//
// Problem: natural sounds (thunder, ocean) have huge low-frequency energy that
// consistently drowns out high-frequency content (birdsong, rain), so the event
// detector almost always picks band A (80-250 Hz) as dominant.
//
// Solution: compute each band’s mean energy across the entire 30 s audio,
// then divide every frame’s energy by that mean.  After normalisation, a value
// of 1.0 means "this band is at its typical level"; 2.0 means "twice as active
// as usual".  The detector now answers the question:
//   “Which band is most UNUSUALLY prominent RIGHT NOW?”
// rather than:
//   “Which band is absolutely the loudest?”
//
// A 1000 Hz tone that briefly jumps to 3× its normal level will outrank a
// 100 Hz rumble that is always at 10× absolute power but never changes.

function normalizeBandEnergies(frames, wavDur) {
  // 1. Compute per-band mean across all frames
  const bandMeans = new Array(BANDS.length).fill(0);
  for (const f of frames) {
    for (let b = 0; b < BANDS.length; b++) bandMeans[b] += f.energies[b];
  }
  const n = frames.length || 1;
  for (let b = 0; b < BANDS.length; b++) bandMeans[b] /= n;

  // Log the raw means so we can see how lopsided the energy distribution is
  console.log(`\n⚖️  Normalising bands by their ${wavDur.toFixed(1)} s mean...`);
  console.log('   Band means (raw energy, before normalisation):');
  BANDS.forEach((band, i) => {
    const val = bandMeans[i];
    const maxVal = Math.max(...bandMeans);
    const bars = '█'.repeat(Math.round((val / maxVal) * 30));
    console.log(`     ${band.key}  [${band.label.padEnd(7)}]  ${bars.padEnd(30)}  ${val.toExponential(2)}`);
  });

  // 2. Divide each frame’s energy by the corresponding band mean
  //    Floor at 1e-12 to avoid division-by-zero on silent bands
  return frames.map(f => ({
    time:     f.time,
    energies: f.energies.map((e, b) => e / Math.max(bandMeans[b], 1e-12)),
  }));
}

// ── Event Detection ───────────────────────────────────────────────────────────

// Helper: average band energies across a slice of smoothed frames
function avgBandEnergies(frames, t0, t1) {
  const avg = new Array(BANDS.length).fill(0);
  let count = 0;
  for (const f of frames) {
    if (f.time < t0 || f.time > t1) continue;
    for (let b = 0; b < BANDS.length; b++) avg[b] += f.energies[b];
    count++;
  }
  if (count === 0) return avg;
  // Normalise to sum=1 so we compare spectral shape, not loudness
  const total = avg.reduce((s, v) => s + v, 0) || 1;
  return avg.map(v => v / total / count);
}

// Cosine distance between two normalised energy profiles (0=identical, 1=orthogonal)
function profileDist(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? 1 - dot / denom : 1;
}

function detectEvents(smoothedFrames) {
  const winSamples = Math.round(SEG_WINDOW_MS / 1000 * SAMPLE_RATE / HOP_SIZE);
  const hopSamples = Math.round(SEG_HOP_MS    / 1000 * SAMPLE_RATE / HOP_SIZE);
  const nFrames    = smoothedFrames.length;

  // ── Step 1: compute profile for each sliding window ───────────────────────
  const windows = [];
  for (let fi = 0; fi + winSamples < nFrames; fi += hopSamples) {
    const t0 = smoothedFrames[fi].time;
    const t1 = smoothedFrames[Math.min(fi + winSamples - 1, nFrames - 1)].time;
    if (t0 < FADE_IN_END || t1 > FADE_OUT_START) continue;

    // Raw average band energies (unnormalised)
    const rawAvg = new Array(BANDS.length).fill(0);
    for (let k = fi; k < fi + winSamples && k < nFrames; k++) {
      for (let b = 0; b < BANDS.length; b++) rawAvg[b] += smoothedFrames[k].energies[b];
    }
    const count = Math.min(winSamples, nFrames - fi);
    const norm  = rawAvg.reduce((s, v) => s + v, 0) || 1;
    const profile = rawAvg.map(v => v / norm);  // normalised spectral shape

    windows.push({ t0, t1, profile, rawAvg: rawAvg.map(v => v / count) });
  }

  // ── Step 2: detect boundaries where spectral profile changes noticeably ───
  const isBoundary = new Array(windows.length).fill(false);
  isBoundary[0] = true;  // always start a new segment at the first window
  for (let i = 1; i < windows.length; i++) {
    const dist = profileDist(windows[i-1].profile, windows[i].profile);
    if (dist > BAND_CHANGE_THRESH) isBoundary[i] = true;
  }

  // ── Step 3: group windows into segments between boundaries ────────────────
  const rawSegs = [];
  let seg = null;
  for (let i = 0; i < windows.length; i++) {
    if (isBoundary[i] || !seg) {
      seg = { startTime: windows[i].t0, endTime: windows[i].t1, windows: [windows[i]] };
      rawSegs.push(seg);
    } else {
      seg.endTime = windows[i].t1;
      seg.windows.push(windows[i]);
    }
  }

  // ── Step 4: apply duration constraints ────────────────────────────────────
  // Merge segments shorter than MIN_EVENT_DUR into predecessor
  const merged = [];
  for (const s of rawSegs) {
    const dur = s.endTime - s.startTime;
    if (dur < MIN_EVENT_DUR && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.endTime = s.endTime;
      prev.windows = prev.windows.concat(s.windows);
    } else {
      merged.push({ ...s, windows: [...s.windows] });
    }
  }

  // Split segments longer than MAX_EVENT_DUR
  const capped = [];
  for (const s of merged) {
    const dur = s.endTime - s.startTime;
    if (dur <= MAX_EVENT_DUR) {
      capped.push(s);
    } else {
      // Prefer 2–3 s chunks
      const targetChunk = 2.0 + Math.random() * 1.0;
      const nParts      = Math.max(2, Math.round(dur / targetChunk));
      const partDur     = dur / nParts;
      for (let p = 0; p < nParts; p++) {
        const t0   = s.startTime + p * partDur;
        const t1   = t0 + partDur;
        const wins = s.windows.filter(w => w.t0 >= t0 - 0.01 && w.t0 < t1 + 0.01);
        capped.push({ startTime: t0, endTime: t1, windows: wins.length ? wins : s.windows });
      }
    }
  }

  // ── Step 5: place events with free-play gaps ──────────────────────────────
  const events = [];
  let cursor = FADE_IN_END;

  for (const seg of capped) {
    const eventStart = Math.max(cursor, seg.startTime);
    const rawDur     = seg.endTime - seg.startTime;
    const eventDur   = Math.max(MIN_EVENT_DUR, Math.min(MAX_EVENT_DUR, rawDur));
    const eventEnd   = eventStart + eventDur;
    if (eventEnd > FADE_OUT_START) break;

    // ── Step 6: classify event ────────────────────────────────────────────────
    // Average the raw (unnormalised) band energies across all windows in the segment
    const avgE = new Array(BANDS.length).fill(0);
    for (const w of seg.windows) { for (let b = 0; b < BANDS.length; b++) avgE[b] += w.rawAvg[b]; }
    const wn = seg.windows.length || 1;
    for (let b = 0; b < BANDS.length; b++) avgE[b] /= wn;

    const sorted = avgE
      .map((e, i) => ({ bandIdx: i, energy: e }))
      .sort((a, b) => b.energy - a.energy);

    const first  = sorted[0];
    const second = sorted[1];
    const isDual = second.energy >= DUAL_RATIO * first.energy;
    const keys   = isDual
      ? [BANDS[first.bandIdx].key, BANDS[second.bandIdx].key]
      : [BANDS[first.bandIdx].key];

    events.push({
      id:            events.length,
      startTime:     parseFloat(eventStart.toFixed(3)),
      duration:      parseFloat(eventDur.toFixed(3)),
      releaseWindow: RELEASE_WIN,
      keys,
      type:          isDual ? 'dual-simultaneous' : 'single',
      _bandLabel:    keys.map(k => BANDS.find(b => b.key === k).label).join('+'),
      _dominantIdx:  first.bandIdx,
    });

    cursor = eventEnd + MIN_GAP;
  }

  return events;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(IN_WAV)) {
    console.error('❌  audio/merged.wav not found. Run splice.js first.');
    process.exit(1);
  }

  // 1. Load merged audio as mono
  console.log('\n📂 Reading merged.wav...');
  const { mono, sampleRate } = readWAVMono(IN_WAV);
  const wavDur = mono.length / sampleRate;
  console.log(`   ${mono.length} samples @ ${sampleRate} Hz  (${wavDur.toFixed(2)} s)`);
  
  // Set end buffer relative to audio length
  FADE_OUT_START = wavDur - 2.0;

  if (sampleRate !== SAMPLE_RATE) {
    console.warn(`⚠️  Expected ${SAMPLE_RATE} Hz but got ${sampleRate} Hz. Results may be off.`);
  }

  // 2. FFT analysis
  console.log('\n🔬 Analyzing frames...');
  const rawFrames = analyzeFrames(mono);

  // 3. Smooth energies in time
  console.log('\n📊 Smoothing energy curves...');
  const smoothed = smoothEnergies(rawFrames);

  // 3b. Per-band mean normalisation — makes quiet bands compete with loud ones
  const normalised = normalizeBandEnergies(smoothed, wavDur);

  // 4. Detect events (now using normalised energies)
  console.log('\n🎯 Detecting events...');
  const events = detectEvents(normalised);

  // 5. Print summary
  console.log(`\n   Found ${events.length} events:\n`);
  console.log('   id  startTime  duration  type               keys');
  console.log('   ─────────────────────────────────────────────────────');
  events.forEach(ev => {
    const start = ev.startTime.toFixed(2).padStart(5);
    const dur   = ev.duration.toFixed(2).padStart(5);
    const type  = ev.type.padEnd(18);
    const keys  = ev.keys.join('+').padEnd(4);
    const label = ev._bandLabel;
    console.log(`   ${String(ev.id).padStart(2)}  ${start}s     ${dur}s   ${type}  [${keys}]  (${label})`);
  });

  // Compute coverage stats
  const totalEventTime = events.reduce((s, e) => s + e.duration, 0);
  const numEv = events.length;
  const covRatio = totalEventTime / wavDur;
  const avgDur   = numEv > 0 ? totalEventTime / numEv : 0;

  console.log(`\n   Coverage: ${totalEventTime.toFixed(1)}s of events in ${wavDur}s audio`);
  console.log(`   Average event duration: ${avgDur.toFixed(2)}s\n`);

  // Compute summary stats
  const keyCounts = { 'A': 0, 'S': 0, 'D': 0, 'L': 0, ';': 0, "'": 0 };
  const typeCounts = { 'single': 0, 'dual-simultaneous': 0 };

  events.forEach(ev => {
    typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
    ev.keys.forEach(k => {
      keyCounts[k] = (keyCounts[k] || 0) + 1;
    });
  });

  console.log('\n   📊 Summary Stats:');
  console.log(`   • Total Events: ${events.length} (Single: ${typeCounts['single']}, Dual: ${typeCounts['dual-simultaneous']})`);
  console.log(`   • Key Hits: A:${keyCounts['A']} | S:${keyCounts['S']} | D:${keyCounts['D']} | L:${keyCounts['L']} | ;:${keyCounts[';']} | ':${keyCounts["'"]}`);

  // 6. Write events.json
  const output = {
    generatedAt:   new Date().toISOString(),
    totalDuration: 30.0,
    sampleRate:    SAMPLE_RATE,
    summary: {
      totalEvents: events.length,
      typeCounts,
      keyCounts,
    },
    bands:         BANDS,
    events:        events.map(({ _bandLabel, _dominantIdx, ...ev }) => ev), // strip debug fields
    _debug: {
      eventsWithLabels: events,
      smoothFrameCount: smoothed.length,
    },
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(output, null, 2));
  console.log(`\n✅ Written: audio/events.json`);
}

main();
