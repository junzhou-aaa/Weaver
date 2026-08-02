# 🎵 Nature Soundscape Interactive Orb — Product Design v1.0 ✅ Finalized

> Audio is a machine that requires your continuous power supply. Press correctly, and it runs smoothly; release or press incorrectly, and it slows down like a record player losing power, slowly fading into silence. All design decisions have been confirmed and are ready for implementation.

---

## I. Product Overview

**Product Name**: Tentatively "Nature Orb"

**Core Experience**:

This is a **"continuous power supply"** sound interaction game—

- The audio acts like a machine. If you hold down the correct key(s), it runs at normal speed.
- If you don't press, press incorrectly, or release at the wrong time, it **decelerates exponentially** until it stops.
- Only by correctly holding + releasing at the right time can you "unlock" the next segment of sound.
- There are no failures and no score deductions, but you clearly feel that "the music flows because of you, and falls silent because of you."

**Core Audience**: Users with ADHD or those needing hand soothing + sensory stimulation. Keeping both hands anchored on 6 fixed keys (S, D, F, J, K, L) prevents anxious behaviors (like nail-biting) while providing stress relief through dual audio-visual channels.

---

## II. Game Flow

```
[Load Page]
  ① Randomly pick 1 of 5 pre-generated soundscapes
  Visual: Loading overlay, then "Ready"
    ↓
[Interactive Playback]
  PLAYING → Event → WAITING (slowdown) → User holds → HOLDING → Release → PLAYING
  ... Until 45s content finishes playing ...
    ↓
[End]
  Audio fades out, orb turns white, background blurs
  Shows "Regenerate Sounds" button
    ↓
[Click Regenerate]
  Randomly switch to another pre-generated 45s track and start over
```

---

## III. Audio System Design

### 3.1 Asset Preparation ✅

- 5 segments of natural sound effects (WAV) are preloaded as raw sources.
- A build script extracts slices up to 15s, splicing them dynamically into exactly a **45s track**.
- The first segment fades in + clips crossfade (1.5s) + the last segment fades out.
- The system pre-generates 5 complete tracks to serve as purely static frontend assets.

### 3.2 Key Chart Generation

An **offline FFT analysis** is performed on the 45s audio to generate an **Event Sequence**:

#### Frequency Band Definitions

| Key | Band | Color |
|------|------|------|
| S | ~80–250 Hz (Low) | 🔴 Dark Red |
| D | ~250–500 Hz (MidLow) | 🟠 Orange |
| F | ~500–1k Hz (Mid) | 🟡 Yellow-Green |
| J | ~1k–2k Hz (MidHi) | 🟢 Cyan-Green |
| K | ~2k–5k Hz (High) | 🔵 Blue |
| L | ~5k–16k Hz (Ultra) | 🟣 Purple |

#### Event Data Structure

```
Event {
  start_time:     Start time in seconds on the audio timeline
  duration:       Event duration (2~4.5s, varying speeds)
  required_keys:  Keys required to be held (1 or 2)
  release_window: Permitted time window for release (duration ± ~0.3s)
}
```

#### Rhythm Distribution

- Fast beats: 2~3s, compact and continuous
- Slow beats: 3~4.5s, deep and stretched
- A rich mix of fast and slow pacing overall
- Occasional dual-key simultaneous or staggered presses

---

## IV. Core Interaction Mechanism ✅ All Confirmed

### 4.1 State Machine

```
[PLAYING]
  Audio plays normally at playbackRate = 1.0
  ↓ (Reaches event start time)
[WAITING_FOR_PRESS]
  Arc segments begin to pulse as a prompt
  playbackRate decays exponentially (volume also fades down)
  ↓ (User presses the correct key after the arc lights up)
[HOLDING]
  Audio accelerates back to playbackRate = 1.0 (approx. 100ms)
  Orb changes color, arc stays illuminated solid
  ↓ (User releases within the release_window)
[PLAYING]  →  Next segment
```

### 4.2 Exponential Slowdown Curve

When in the `WAITING_FOR_PRESS` state, or if held too long:

```
playbackRate(t) = e^(−λ · t)
```

After the user presses the correct key, the rate linearly recovers to 1.0 within ~100ms. A `masterGain` parameter mirrors the slowdown to prevent weird pitch distortions at very low playback rates.

### 4.3 Hold + Release Mechanism

```
✅ Correct Flow:
  ① Arc lights up (Event start_time)
  ② User presses the correct key (strictly after it lights up)
     → rate quickly recovers to 1.0, orb changes color
  ③ User continues to hold
  ④ Releases within the release_window
     → Unlocked, enters PLAYING, arc extinguishes

❌ Error Scenario A: Early release (before release_window begins)
  → rate resumes exponential decay
  → Arc resumes pulsing (waiting to be pressed again)

❌ Error Scenario B: Held too long (still holding after release_window ends) ✅
  → rate resumes exponential decay
  → Arc resumes pulsing
  → Requires releasing and then pressing again (strict timing requirement for release)

❌ Error Scenario C: Wrong key or no key pressed
  → Treated exactly as not pressing at all, no feedback, rate continues to decay
```

### 4.4 Dual-Key Events

| Type | Description | Operation Requirement |
|------|------|----------|
| **Simultaneous Dual-Key** | Two arcs light up at the same time | Both keys must be held, and both must be released within the window |
| **Staggered Dual-Key** | F lights up first, ~0.5s later D lights up while F is still active | Hold F first, then add D when it lights up, release both within a unified window |

---

## V. Visual UI Design

### 5.1 Overall Layout (Hemisphere Mapping)

```
┌─────────────────────────────────────┐
│           Nature Orb                │
│                                     │
│         ╭──────────╮               │
│      🔵 │  ╭────╮  │ 🟠            │
│    🟢   │  │ ◉  │  │   🔴          │
│      🟡 │  ╰────╯  │ 🟣            │
│         ╰──────────╯               │
│                                     │
│ Left Hand │ Right Hand             │
│   F D S   │   J K L                │
│                                     │
│           [Status Text]            │
└─────────────────────────────────────┘
```

*Note: The arcs are mapped ergonomically. Left hemisphere corresponds to Left Hand (F, D, S) and right hemisphere corresponds to Right Hand (J, K, L).*

### 5.2 Breathing Animation Linked to playbackRate

The orb's **breathing frequency** is linked in real-time with `playbackRate`:

- rate = 1.0 → Normal breathing (~0.3Hz)
- rate = 0.5 → Breathing halved (~0.15Hz)
- rate → 0 → Orb is almost still, with only very faint pulsations

> No numerical display is needed; users intuitively perceive the audio state from the orb's "sense of life".

### 5.3 Color System

- Multi-key color mixing: Weighted average of active band colors
- Staggered press: First pressed color → Blends into the second pressed color
- When audio finishes, the orb loses color and slowly turns to pure white.

---

## VI. Technology Stack

| Module | Solution |
|------|------|
| Audio Splicing | Node.js `fs` + buffer manipulation (offline build script) |
| Offline FFT Analysis | Custom Node.js fast-fourier-transform on RAW PCM |
| Key Chart Generation | Sliding window peak detection algorithm, outputs Event[] |
| Slowdown Control | AudioBufferSourceNode.playbackRate (Native Web Audio API) |
| Animation Rendering | Canvas 2D + requestAnimationFrame |
| Orb Breathing Link | Reads playbackRate per frame, maps to scale amplitude |
| Keyboard Listening | keydown / keyup |
| Deployment | Pure static HTML/JS/CSS served via Render Static Site |

---

*Design Document Version: v2.0 ✅ Updated for Final Product*
