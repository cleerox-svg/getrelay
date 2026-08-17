// THE BOARD'S OWN PIXELS — a dev/CI-only page that paints every board screen
// onto a canvas at the size the batter actually sees it, and nothing else.
//
// ⚠ IT EXISTS BECAUSE RENDERING-AND-LOOKING BEAT THE SUITE, AGAIN. The board
// slice stood a throwaway version of this page up over the real modules and
// found FIVE defects while its 52 tests were green:
//
//     • a caption truncated to `SWING AND A MI…` — the main panel was 59 ft
//     • a rule bar drawn straight through a line of text
//     • an exclamation dot printed on top of a zero
//     • a ribbon celebration whose word was unreadable against its own chase
//     • idle panels the same shade as the frame, which collapsed the entire
//       "it is an array, not one rectangle" effect
//
// None of those is expressible as a unit test without first knowing to look for
// it, and every one is obvious in a picture. That harness was deleted as out of
// scope and recommended for commit; this is it. It is the FIFTH time on this
// game that looking beat the suite — the reversed turf winding (every camera
// photographing the concrete under the field, 15/15 passing), a hole in the
// backstop, the skyline strip, the board's own layout collisions, and the camera
// losing the ball.
//
// ⚠ IT IS NOT A SECOND RENDERER AND IT IS NOT A MOCK. It imports the SHIPPING
// modules — `boardArrayOps`, `ribbonOps` and `emitBoardOps` — and rasterises
// them with the same code path `scoreboard.ts` uses. A page that redrew the
// board its own way would be photographing something the game cannot produce.
//
// ⚠ NO `three`, NO WEBGL, NO STADIUM. That is the whole value: it boots in
// milliseconds, it has no camera to get wrong, and it can show TWELVE states in
// one image where the GL gate photographs one.
//
// URL query:
//   ?scale=<n>   device px per atlas texel column. Default 1.
//   ?state=<id>  show ONE state, full width, instead of the contact sheet.

import { createRoot } from 'react-dom/client';
import {
  BOARD_ANIM_FPS,
  BOARD_ARRAY_ASPECT,
  BOARD_GEOMETRY,
} from './components/baseball/stadium/scoreboard';
import type { BoardArray } from './components/baseball/stadium/scoreboard';
import { boardArrayOps } from './components/baseball/stadium/boardAtlas';
import { emitBoardOps } from './components/baseball/stadium/boardPaint';
import { RIBBON_H, RIBBON_W, ribbonOps } from './components/baseball/stadium/boardRibbon';
import { BOARD_STATES } from './components/baseball/stadium/boardFixtures';

const params = new URLSearchParams(location.search);
const scale = Math.max(0.25, Number.parseFloat(params.get('scale') ?? '') || 1);
const only = params.get('state');

/**
 * Atlas width, px, for the contact sheet.
 *
 * ⚠ 1024 IS THE SHIPPING TEXTURE WIDTH, and using it rather than a "nice"
 * number is the point: a glyph that is legible here at 1:1 is a glyph that is
 * legible on the GPU. Halving it to fit more states on a page would be testing a
 * texture the game never uploads.
 */
const W = 1024;
const H = Math.round(W / BOARD_ARRAY_ASPECT);

function paint(canvas: HTMLCanvasElement, array: BoardArray, frame: number) {
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return;
  emitBoardOps(g, boardArrayOps(array, frame), W, H);
}

function paintRibbon(canvas: HTMLCanvasElement, array: BoardArray, frame: number) {
  canvas.width = RIBBON_W;
  canvas.height = RIBBON_H;
  const g = canvas.getContext('2d');
  if (!g) return;
  emitBoardOps(g, ribbonOps(array, frame), RIBBON_W, RIBBON_H);
}

function Sheet() {
  const rows = BOARD_STATES.filter((s) => !only || s.id === only);
  return (
    <div style={{ background: '#101418', color: '#cfd6e4', font: '12px/1.4 system-ui, sans-serif' }}>
      {rows.map((s) => (
        <div key={s.id} style={{ padding: '10px 12px 18px' }}>
          <div style={{ marginBottom: 4, letterSpacing: 0.5 }}>
            {s.id} — {s.note} · frame {s.frame} (t ≈ {(s.frame / BOARD_ANIM_FPS).toFixed(2)} s)
          </div>
          <canvas
            ref={(c) => {
              if (c) paint(c, s.array, s.frame);
            }}
            style={{ width: W * scale, height: H * scale, display: 'block', imageRendering: 'pixelated' }}
          />
          <canvas
            ref={(c) => {
              if (c) paintRibbon(c, s.array, s.frame);
            }}
            style={{
              width: W * scale,
              // The ribbon tile is 32:1; showing it at the atlas's width makes
              // its glyphs the same texel size as the atlas's, which is the
              // comparison worth having.
              height: ((W * scale) / RIBBON_W) * RIBBON_H,
              display: 'block',
              marginTop: 6,
              imageRendering: 'pixelated',
            }}
          />
        </div>
      ))}
      <div style={{ padding: '0 12px 16px', opacity: 0.7 }}>
        geometry {BOARD_GEOMETRY.widthFt}×{BOARD_GEOMETRY.heightFt} ft at {BOARD_GEOMETRY.faceDistFt} ft
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Sheet />);
// The beacon the shooter waits on. No `three`, no async build — one synchronous
// render is the whole page — but the flag is still set from a frame callback so
// the canvases have actually been painted before anything screenshots them.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    (window as unknown as { __boardPixelsReady?: boolean }).__boardPixelsReady = true;
  });
});
