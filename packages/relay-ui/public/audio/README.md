# Golf audio — real-sample drop-in

The golf game ships with **procedural synth** sound effects and a soft synth
music bed. Every sound can be upgraded to a real royalty-free file **without
touching any code except one line** in the manifest.

Files in this folder are served from `/audio/...` on Cloudflare Pages (this is
the static `public/` dir — same place as the icons and manifest).

## How to activate a real sound (one step)

1. Drop the file in this folder using the **exact filename** from the table
   below (e.g. `swing.mp3`).
2. Open `packages/relay-ui/src/lib/audio/engine.ts`, find `SAMPLE_FILES`, and
   **uncomment** that sound's line.

That's it. On the next play, the decoded file transparently **shadows** the
synth — no call site changes. If the file is missing or fails to decode, it
silently falls back to the synth, so an uncommented line without a file just
means "keep the synth."

The manifest ships **empty** (all lines commented) on purpose: with nothing
uncommented there are **zero** audio network requests and the synth plays.

## Shopping list (target filenames)

| Manifest key | Filename    | What it is                         | Recommended clip |
|--------------|-------------|------------------------------------|------------------|
| `swing`      | `swing.mp3` | Driver/iron impact — crack + whoosh | short, ~0.3–0.6 s, mono |
| `putt`       | `putt.mp3`  | Putter "tock" (ball off the face)   | very short, ~0.1–0.2 s, mono |
| `land`       | `bounce.mp3`| Ball's first ground contact / bounce| short, ~0.1–0.2 s, mono |
| `splash`     | `splash.mp3`| Ball into water                     | short, ~0.3–0.5 s, mono |
| `sink`       | `sink.mp3`  | Ball drops in the cup (the rattle)  | short, ~0.3–0.6 s, mono |
| `ding`       | `ding.mp3`  | Positive confirm / flagstick / target hit | short, ~0.3–0.5 s, mono |
| `music`      | `music.mp3` | Background loop (menu + play)       | **seamless loop**, ~30–90 s, stereo OK |

Notes on format:
- **SFX**: short **mono** `.mp3` (or `.ogg`) keeps the bundle-adjacent download
  tiny. Trim silence off the head so the sound is punchy and in-sync with the
  hit. Normalize but leave a little headroom (the engine adds its own per-shot
  gain and a conservative bus level).
- **Music**: a **loopable** track — the first and last samples must join
  cleanly, because the engine loops it with `AudioBufferSourceNode.loop = true`
  (no crossfade). Export a loop that has been trimmed at zero-crossings. ~30–90 s
  keeps the file small while avoiding obvious repetition. Turning music ON is a
  user opt-in (it now defaults **OFF**).

You don't have to fill in the whole table — activate only the ones you have.
The rest keep their synth.

## Where to source (no-attribution, app-bundling OK)

- **Pixabay** — https://pixabay.com/sound-effects/search/golf/
  (Pixabay Content License: free for commercial use, **no attribution
  required**, bundling in an app is fine.)
- **Mixkit** — https://mixkit.co/free-sound-effects/golf/
  (Mixkit Free License: free for commercial and personal projects, **no
  attribution required**; you may not resell the sounds standalone.)
- **Freesound** — https://freesound.org/search/?q=golf
  (Mixed licenses — prefer **CC0** clips. Some are **CC-BY**, which require
  crediting the author. Check each clip's license before bundling.)

## License / credits — record what you add

For every file you drop in, note its **source URL and license** here so we keep
an audit trail (some Freesound clips require attribution). Suggested format:

| File | Source URL | License | Author (if CC-BY) |
|------|------------|---------|-------------------|
| _e.g._ `putt.mp3` | https://pixabay.com/sound-effects/... | Pixabay | — |

(Leave this table until you actually add files.)
