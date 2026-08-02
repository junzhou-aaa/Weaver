#!/usr/bin/env node
/**
 * Nature Orb — Audio Splice Script
 *
 * Randomly selects 3 from all WAV files in the parent directory,
 * trims each to a target duration (handles short files),
 * applies crossfade between clips and fade-in/out at ends,
 * then writes a merged 30s WAV + JSON manifest.
 *
 * Usage:  node splice.js
 * Output: audio/merged.wav, audio/manifest.json
 */

const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
const AUDIO_DIR    = path.join(__dirname, '..');   // WAVs live in parent dir
const OUT_DIR      = path.join(__dirname, 'audio');
const OUT_WAV      = path.join(OUT_DIR, 'merged.wav');
const OUT_JSON     = path.join(OUT_DIR, 'manifest.json');

const SAMPLE_RATE  = 44100;   // unified output sample rate (Hz)
const TARGET_TOTAL = 45.0;    // total merged duration (seconds)
const DEFAULT_CLIP = 15.0;    // target clip duration per file
const CROSSFADE    = 1.5;     // crossfade duration between clips (seconds)
const FADE_IN      = 1.0;     // opening fade-in (seconds)
const FADE_OUT     = 1.5;     // closing fade-out (seconds)
const SHORT_THRESH = DEFAULT_CLIP; // files shorter than this are "short"

// ── WAV reader ───────────────────────────────────────────────────────────────

function readWAV(filePath) {
  const buf  = fs.readFileSync(filePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`Not RIFF: ${filePath}`);
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`Not WAVE: ${filePath}`);

  let offset = 12;
  let fmt = null, dataOffset = 0, dataSize = 0;

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
      dataOffset = offset;
      dataSize   = chunkSize;
      break;
    }
    offset += chunkSize + (chunkSize % 2); // word-align
  }

  if (!fmt) throw new Error(`No fmt chunk: ${filePath}`);
  if (fmt.audioFmt !== 1 && fmt.audioFmt !== 3)
    throw new Error(`Unsupported format ${fmt.audioFmt}: ${filePath}`);

  const bytesPerSample = fmt.bitsPerSample / 8;
  const totalSamples   = Math.floor(dataSize / bytesPerSample / fmt.numChannels);
  const duration       = totalSamples / fmt.sampleRate;

  // Decode to float32 per channel
  const channels = Array.from({ length: fmt.numChannels }, () => new Float32Array(totalSamples));

  for (let i = 0; i < totalSamples; i++) {
    for (let ch = 0; ch < fmt.numChannels; ch++) {
      const pos = dataOffset + (i * fmt.numChannels + ch) * bytesPerSample;
      let s;
      if (fmt.audioFmt === 3) {
        s = fmt.bitsPerSample === 32
          ? view.getFloat32(pos, true)
          : view.getFloat64(pos, true);
      } else {
        switch (fmt.bitsPerSample) {
          case 8:  s = (buf[pos] - 128) / 128.0; break;
          case 16: s = view.getInt16(pos, true) / 32768.0; break;
          case 24: {
            let v = (buf[pos+2] << 16) | (buf[pos+1] << 8) | buf[pos];
            if (v >= 0x800000) v -= 0x1000000;
            s = v / 8388608.0;
            break;
          }
          case 32: s = view.getInt32(pos, true) / 2147483648.0; break;
          default: s = 0;
        }
      }
      channels[ch][i] = s;
    }
  }

  return { channels, sampleRate: fmt.sampleRate, numChannels: fmt.numChannels, duration };
}

// ── DSP helpers ──────────────────────────────────────────────────────────────

function resample(ch, fromRate, toRate) {
  if (fromRate === toRate) return ch;
  const ratio  = fromRate / toRate;
  const outLen = Math.floor(ch.length / ratio);
  const out    = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const lo  = Math.floor(src);
    const hi  = Math.min(lo + 1, ch.length - 1);
    out[i]    = ch[lo] * (1 - (src - lo)) + ch[hi] * (src - lo);
  }
  return out;
}

function toStereo(channels) {
  return channels.length >= 2 ? [channels[0], channels[1]] : [channels[0], channels[0]];
}

function sliceSamples(stereo, sr, startSec, durSec) {
  const s = Math.floor(startSec * sr);
  const e = Math.min(s + Math.floor(durSec * sr), stereo[0].length);
  return stereo.map(ch => ch.slice(s, e));
}

// ── WAV writer (16-bit PCM stereo) ───────────────────────────────────────────

function writeWAV(filePath, L, R, sr) {
  const n        = L.length;
  const dataSize = n * 4;          // 16-bit × 2 ch
  const buf      = Buffer.alloc(44 + dataSize);
  const dv       = new DataView(buf.buffer);

  buf.write('RIFF', 0);
  dv.setUint32(4,  36 + dataSize, true);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  dv.setUint32(16, 16,       true);
  dv.setUint16(20, 1,        true); // PCM
  dv.setUint16(22, 2,        true); // stereo
  dv.setUint32(24, sr,       true);
  dv.setUint32(28, sr * 4,   true); // byte rate
  dv.setUint16(32, 4,        true); // block align
  dv.setUint16(34, 16,       true); // bits per sample
  buf.write('data', 36);
  dv.setUint32(40, dataSize, true);

  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4,     Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true);
    dv.setInt16(44 + i * 4 + 2, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true);
  }
  fs.writeFileSync(filePath, buf);
  console.log(`✅ Written: ${path.basename(filePath)} (${(buf.length / 1e6).toFixed(2)} MB)`);
}

// ── RMS Volume Normalization ─────────────────────────────────────────────────
// Target RMS ≈ -18 dBFS (0.126 linear). Max gain capped at 4× (+12 dB)
// to avoid over-amplifying near-silent passages.
const TARGET_RMS = 0.10;
const MAX_GAIN   = 4.0;

function clipRMS(stereo) {
  const L = stereo[0], R = stereo[1];
  let sum = 0;
  for (let i = 0; i < L.length; i++) sum += L[i]*L[i] + R[i]*R[i];
  return Math.sqrt(sum / (L.length * 2));
}

function normalizeClip(stereo) {
  const rms = clipRMS(stereo);
  if (rms < 1e-10) return stereo;          // silent clip, skip
  const gain = Math.min(TARGET_RMS / rms, MAX_GAIN);
  return stereo.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gain;
    return out;
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Find & shuffle WAV files
  const allWAVs = fs.readdirSync(AUDIO_DIR)
    .filter(f => f.toLowerCase().endsWith('.wav'))
    .map(f => path.join(AUDIO_DIR, f))
    .sort(() => Math.random() - 0.5);

  if (allWAVs.length < 3) throw new Error('Need at least 3 WAV files in parent directory');

  // 2. Read headers and plan durations dynamically to hit exactly TARGET_TOTAL
  console.log('\n🔍 Planning clips...');
  const infos = [];
  const clipDurs = [];
  let totalPlanned = 0;

  for (const fp of allWAVs) {
    const wav = readWAV(fp);
    const durToUse = Math.min(wav.duration, DEFAULT_CLIP);
    infos.push({ fp, duration: wav.duration, sampleRate: wav.sampleRate, numChannels: wav.numChannels });
    clipDurs.push(durToUse);
    totalPlanned += durToUse;
    
    if (totalPlanned >= TARGET_TOTAL) {
      break;
    }
  }

  // Adjust the last clip to exactly hit TARGET_TOTAL if it overshot
  if (totalPlanned > TARGET_TOTAL) {
    const diff = totalPlanned - TARGET_TOTAL;
    clipDurs[clipDurs.length - 1] -= diff;
  }

  console.log('\n📂 Selected:');
  infos.forEach((f, i) => {
    console.log(`  • ${path.basename(f.fp)} (taking ${clipDurs[i].toFixed(2)}s)`);
  });

  // 4. Random start offsets
  const starts = infos.map((f, i) => {
    const maxStart = Math.max(0, f.duration - clipDurs[i]);
    return Math.random() * maxStart;
  });

  console.log('\n✂️  Clip plan:');
  infos.forEach((f, i) => {
    console.log(`  [${i+1}] start=${starts[i].toFixed(2)}s  dur=${clipDurs[i].toFixed(2)}s  ← ${path.basename(f.fp)}`);
  });

  // 5. Decode, resample, slice, normalize
  console.log('\n📥 Decoding, resampling & normalizing...');
  const clips = infos.map((f, i) => {
    process.stdout.write(`  [${i+1}] ${path.basename(f.fp)} ... `);
    const wav        = readWAV(f.fp);
    const stereo     = toStereo(wav.channels);
    const rs         = stereo.map(ch => resample(ch, wav.sampleRate, SAMPLE_RATE));
    const sliced     = sliceSamples(rs, SAMPLE_RATE, starts[i], clipDurs[i]);
    const normalized = normalizeClip(sliced);
    const rmsAfter   = clipRMS(normalized).toFixed(4);
    console.log(`done  (${sliced[0].length} samps, RMS→${rmsAfter})`);
    return normalized;
  });

  // 6. Crossfade-merge
  console.log('\n🔀 Merging with crossfade...');
  const xfSamples  = Math.floor(CROSSFADE * SAMPLE_RATE);
  const totalSamps = Math.floor(TARGET_TOTAL * SAMPLE_RATE);
  const outL = new Float32Array(totalSamps);
  const outR = new Float32Array(totalSamps);

  let writePos = 0;
  for (let ci = 0; ci < clips.length; ci++) {
    const [cL, cR] = clips[ci];
    const len = cL.length;

    for (let s = 0; s < len; s++) {
      if (writePos >= totalSamps) break;

      if (ci > 0 && s < xfSamples) {
        // Crossfade zone: blend in
        const t = s / xfSamples;
        outL[writePos] = outL[writePos] * (1 - t) + cL[s] * t;
        outR[writePos] = outR[writePos] * (1 - t) + cR[s] * t;
      } else {
        outL[writePos] = cL[s];
        outR[writePos] = cR[s];
      }
      writePos++;
    }

    // Overlap with next clip
    if (ci < clips.length - 1) {
      writePos = Math.max(0, writePos - xfSamples);
    }
  }

  // 7. Global fade-in / fade-out
  const fiSamps = Math.floor(FADE_IN  * SAMPLE_RATE);
  const foSamps = Math.floor(FADE_OUT * SAMPLE_RATE);
  for (let i = 0; i < fiSamps; i++) {
    const g = i / fiSamps;
    outL[i] *= g; outR[i] *= g;
  }
  for (let i = 0; i < foSamps; i++) {
    const idx = totalSamps - 1 - i;
    const g   = i / foSamps;
    outL[idx] *= g; outR[idx] *= g;
  }

  // 8. Write output
  console.log('\n💾 Writing output...');
  writeWAV(OUT_WAV, outL, outR, SAMPLE_RATE);

  const manifest = {
    generatedAt:   new Date().toISOString(),
    totalDuration: TARGET_TOTAL,
    sampleRate:    SAMPLE_RATE,
    crossfade:     CROSSFADE,
    clips: infos.map((f, i) => ({
      file:        path.basename(f.fp),
      startOffset: parseFloat(starts[i].toFixed(3)),
      duration:    parseFloat(clipDurs[i].toFixed(3)),
    })),
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(manifest, null, 2));
  console.log('✅ Written: manifest.json');
  console.log('\n🎵 Manifest:');
  console.log(JSON.stringify(manifest, null, 2));
}

main();
