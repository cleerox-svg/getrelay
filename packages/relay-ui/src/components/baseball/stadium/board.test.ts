// THE BOARD, MOUNTED — its placement in the park, and the celebration chain.
//
// ⚠ WHAT THIS FILE CAN AND CANNOT SEE. `buildBoard` needs a DOM (two canvases)
// and this suite runs in node, so what is asserted here is the PURE half:
// `boardPanelRects`, `boardGeometryFor` and `towerState`. The impure half — that
// the four rects become one merged draw call reading one atlas — is asserted by
// the screenshot harness, which reads `panels` and the upload counters back out
// of a real renderer (`checkBoard` in `scripts/shoot-baseball.mjs`), and by
// `scripts/shoot-board.mjs`, which photographs the picture itself.
//
// The split is deliberate rather than a gap: a test that mocked a canvas to
// prove a quad exists would be asserting its own mock.

import { describe, expect, it } from 'vitest';
import { CENTREFIELD_BOARD, MULLION_BEHIND_FT, MULLION_BLEED_FT } from './centrefieldSpec';
import { BOARD_PANELS, boardPanel } from './boardAtlas';
import { boardGeometryFor, boardPanelRects, idleBoardArray } from './board';
import { RIBBON_SWEEP_S, TOWER_FLASH_LEVEL, TOWER_SWEEPS_PER_LAP, towerState } from './boardRibbon';
import { BOARD_ANIM_FPS, boardAnimFrame } from './boardPaint';
import { HARBOURFRONT } from '../../../lib/baseball/parks';
import type { StandsPart } from './stands';

const SILL = CENTREFIELD_BOARD.sillFt;

const rects = () =>
  boardPanelRects(
    BOARD_PANELS,
    {
      widthFt: CENTREFIELD_BOARD.widthFt,
      heightFt: CENTREFIELD_BOARD.heightFt,
      faceDistFt: CENTREFIELD_BOARD.faceDistFt,
      ribbonHeightFt: 3.5,
      ribbonRadiusFt: 318,
    },
    SILL,
  );

describe('the board array is mounted where the surround says it is', () => {
  it('spans exactly the face `centrefieldSpec` publishes, and nothing more', () => {
    const r = rects();
    expect(r.length).toBe(4);
    const x0 = Math.min(...r.map((p) => p.x0));
    const x1 = Math.max(...r.map((p) => p.x1));
    const y0 = Math.min(...r.map((p) => p.y0));
    const y1 = Math.max(...r.map((p) => p.y1));
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — the array as MOUNTED, scene ft]\n` +
        `  face   ${CENTREFIELD_BOARD.widthFt}×${CENTREFIELD_BOARD.heightFt} ft at ` +
        `${CENTREFIELD_BOARD.faceDistFt} ft, sill ${SILL} ft, bearing ${CENTREFIELD_BOARD.bearingDeg}°\n` +
        r
          .map(
            (p) =>
              `  ${p.id.padEnd(8)} x ${p.x0.toFixed(2).padStart(7)} → ${p.x1.toFixed(2).padStart(7)}` +
              `   y ${p.y0.toFixed(2).padStart(6)} → ${p.y1.toFixed(2).padStart(6)}   z ${p.z.toFixed(1)}`,
          )
          .join('\n') +
        `\n  panels occupy ${x0.toFixed(2)} → ${x1.toFixed(2)} × ${y0.toFixed(2)} → ${y1.toFixed(2)}\n`,
    );
    // The 1 ft outer margin of the panel table, expressed in the park.
    expect(x0).toBeCloseTo(-CENTREFIELD_BOARD.widthFt / 2 + 1, 9);
    expect(x1).toBeCloseTo(CENTREFIELD_BOARD.widthFt / 2 - 1, 9);
    expect(y0).toBeCloseTo(SILL + 1, 9);
    expect(y1).toBeCloseTo(SILL + CENTREFIELD_BOARD.heightFt - 1, 9);
    // Every quad on the declared plane, flat, facing the plate.
    for (const p of r) expect(p.z).toBe(-CENTREFIELD_BOARD.faceDistFt);
  });

  it('leaves REAL GAPS between panels — the whole "array, not a rectangle" claim', () => {
    // ⚠ THIS IS THE ONE PROPERTY THE DESIGN RESTS ON AND IT IS GEOMETRIC, NOT
    // PICTORIAL. The atlas deliberately leaves the frame gaps unpainted; if the
    // quads touched, there would be nothing for the dark backing to show through
    // and the array would read as one rectangle — which is precisely the
    // impression the whole centre-field elevation exists to undo.
    const r = rects();
    let minGap = Infinity;
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i]!;
        const b = r[j]!;
        const gap = Math.max(
          Math.max(a.x0 - b.x1, b.x0 - a.x1),
          Math.max(a.y0 - b.y1, b.y0 - a.y1),
        );
        expect(gap, `${a.id}/${b.id}`).toBeGreaterThan(0);
        minGap = Math.min(minGap, gap);
      }
    }
    // 1.0 ft between the three upper panels; 1.5 ft above the strip.
    expect(minGap).toBeCloseTo(1.0, 9);
  });

  it('the backing covers every panel, and sits BEHIND all of them', () => {
    // The complement argument, as arithmetic: `centrefield.boardBacking` is one
    // flat quad at `faceDist + MULLION_BEHIND_FT`, `MULLION_BLEED_FT` proud on
    // every side. Nothing derived from the panel table can escape it, whatever
    // the panel table later says — which is the property that replaced five
    // hand-placed mullions built from a copy of that table that had drifted 7 ft.
    const r = rects();
    const halfW = CENTREFIELD_BOARD.widthFt / 2 + MULLION_BLEED_FT;
    for (const p of r) {
      expect(p.x0).toBeGreaterThanOrEqual(-halfW);
      expect(p.x1).toBeLessThanOrEqual(halfW);
      expect(p.y0).toBeGreaterThanOrEqual(SILL - MULLION_BLEED_FT);
      expect(p.y1).toBeLessThanOrEqual(SILL + CENTREFIELD_BOARD.heightFt + MULLION_BLEED_FT);
      // …and the backing is genuinely further from the plate than the panel.
      expect(CENTREFIELD_BOARD.faceDistFt + MULLION_BEHIND_FT).toBeGreaterThan(-p.z);
    }
    expect(MULLION_BEHIND_FT).toBeGreaterThan(0);
  });

  it('UV rects are the atlas`s own, and they tile it without overlapping', () => {
    // Derived, not authored: the scene reads `BOARD_PANELS[i].uv` and multiplies
    // by the face. A second panel table would be the failure this asserts away.
    const r = rects();
    for (const p of r) expect(p.uv).toEqual(boardPanel(p.id).uv);
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i]!.uv;
        const b = r[j]!.uv;
        const apart = a.u1 <= b.u0 || b.u1 <= a.u0 || a.v1 <= b.v0 || b.v1 <= a.v0;
        expect(apart, `${r[i]!.id}/${r[j]!.id} UV rects overlap`).toBe(true);
      }
    }
    // Every rect inside the texture.
    for (const p of r) {
      expect(p.uv.u0).toBeGreaterThanOrEqual(0);
      expect(p.uv.v0).toBeGreaterThanOrEqual(0);
      expect(p.uv.u1).toBeLessThanOrEqual(1);
      expect(p.uv.v1).toBeLessThanOrEqual(1);
    }
  });

  it('the ribbon geometry is MEASURED off the bowl, never typed', () => {
    // ⚠ THE PROPERTY, NOT THE NUMBER. `ribbonWraps` divides the ring's
    // circumference by the tile width, and the tile width is 32 band-heights —
    // so a hand-set radius or height stretches the typeface everywhere. This
    // asserts that `boardGeometryFor` PASSES THROUGH what the bowl measured.
    const stands = { ribbonHeightFt: 3.49, ribbonRingFt: 2001 } as unknown as StandsPart;
    const g = boardGeometryFor(stands);
    expect(g.ribbonHeightFt).toBe(3.49);
    expect(2 * Math.PI * g.ribbonRadiusFt).toBeCloseTo(2001, 9);
    // …and the face still comes from `centrefieldSpec`, the ONE handoff constant.
    expect(g.widthFt).toBe(CENTREFIELD_BOARD.widthFt);
    expect(g.faceDistFt).toBe(CENTREFIELD_BOARD.faceDistFt);
    // A different bowl gives a different equivalent radius — i.e. it is a
    // function of its argument and not a constant with a parameter beside it.
    const other = boardGeometryFor({ ribbonHeightFt: 5, ribbonRingFt: 1000 } as unknown as StandsPart);
    expect(other.ribbonRadiusFt).not.toBeCloseTo(g.ribbonRadiusFt, 3);
  });

  it('⚠ GOLDEN: the array is IN FRAME from the batter camera, and by how much', () => {
    // ⚠⚠ THIS TEST SHIPPED AS A PINNED DEFECT AND IS NOW A PINNED FIX, and both
    // halves are kept because the number is the whole argument.
    //
    // WHAT IT MEASURED. `CENTREFIELD_BOARD` was 100 × 50 ft at 430 ft, a size the
    // visual gate signed off "505 × 262 px, 56 % of frame width" — against a 40°
    // batter lens. The SHIPPED camera is a 20° lens at 19.5 ft (M3b re-framed it,
    // for the reasons in `camera.ts`), which magnifies ~2×. Measured:
    //
    //     vertical in frame                84.2 %
    //     horizontal, 900×1600 harness     89.2 % of the width
    //     horizontal, 390×844 phone        73.4 % of the width
    //
    // i.e. cropped on three sides, and on a phone the two side columns ran
    // ±3.9° → ±6.35° against a ±4.66° frame — very nearly outside the picture.
    //
    // WHY IT COULD NOT BE PATCHED FROM THE SCENE. `boardGeometryComplaints`
    // refuses any board shorter than `BOARD_REF` (the atlas is authored at the
    // reference and STRETCHED onto the quad, so a smaller quad draws smaller
    // type and lands under the 10 CSS px floor) and any face distance past
    // 430 ft by the same arithmetic. 100 × 50 @ 430 was the UNIQUE admissible
    // point of the board's own rules — so the fix had to be a joint re-authoring
    // of `BOARD_REF` and `BOARD_PANEL_SPECS`, which is a decision about the
    // array's information budget and was taken by the owner rather than by a
    // mounting slice.
    //
    // WHAT IT MEASURES NOW: 66 × 33 ft at 430 ft, sill 26. Fully in frame on
    // both viewports, with margin. The goldens below are two-sided — a board
    // that grew back would fail them, and so would one that shrank to a stamp.
    const EYE = { y: 4, z: 19.5 };
    const FOV_DEG = 20;
    const LOOK = { y: 2.36, z: -30 };
    const deg = (r: number) => (r * 180) / Math.PI;
    const deg2rad = (d: number) => (d * Math.PI) / 180;
    const depth = CENTREFIELD_BOARD.faceDistFt + EYE.z;
    // ⚠ THE FORWARD RUN IS `EYE.z − LOOK.z`, NOT `LOOK.z − EYE.z`. The camera
    // looks down −z, so dividing by a NEGATIVE run flips the sign of the pitch
    // and turns a camera aimed 1.9° DOWN into one aimed 1.9° up — which put the
    // whole board comfortably inside a frame it was in fact cropped by, and the
    // first run of this test printed exactly that (100.0 % vertical, on a board
    // that was demonstrably clipped in the PNG).
    const pitchDeg = deg(Math.atan((LOOK.y - EYE.y) / (EYE.z - LOOK.z)));
    const topEdge = pitchDeg + FOV_DEG / 2;
    const botEdge = pitchDeg - FOV_DEG / 2;
    const boardTop = deg(Math.atan((SILL + CENTREFIELD_BOARD.heightFt - EYE.y) / depth));
    const boardBot = deg(Math.atan((SILL - EYE.y) / depth));
    const halfW = deg(Math.atan(CENTREFIELD_BOARD.widthFt / 2 / depth));
    /** Horizontal half-FOV for a viewport aspect (w/h). */
    const hHalf = (aspect: number) => deg(Math.atan(Math.tan(deg2rad(FOV_DEG / 2)) * aspect));
    const shot = hHalf(900 / 1600);
    const phone = hHalf(390 / 844);
    /** Fraction of the FRAME the board fills, per axis. Under 1 ⇒ it fits. */
    const fillV = (boardTop - boardBot) / (topEdge - botEdge);
    const fillShot = halfW / shot;
    const fillPhone = halfW / phone;
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — FRAMING FROM \`CAMERAS.batter\` (20° lens at 19.5 ft)]\n` +
        `  array ${CENTREFIELD_BOARD.widthFt}×${CENTREFIELD_BOARD.heightFt} ft at ` +
        `${CENTREFIELD_BOARD.faceDistFt} ft, sill ${SILL} ft\n` +
        `  VERTICAL   board ${boardBot.toFixed(2)}° → ${boardTop.toFixed(2)}°,` +
        ` frame ${botEdge.toFixed(2)}° → ${topEdge.toFixed(2)}°` +
        `   in frame ${boardTop <= topEdge ? 'YES' : 'NO — CROPPED'}` +
        `   fills ${(fillV * 100).toFixed(1)} % of frame height\n` +
        `  HORIZONTAL half-angle ${halfW.toFixed(2)}° against a half-frame of\n` +
        `             ${shot.toFixed(2)}° at 900×1600 (harness) → fills ${(fillShot * 100).toFixed(1)} %` +
        `  ${fillShot <= 1 ? 'YES' : 'NO — CROPPED'}\n` +
        `             ${phone.toFixed(2)}° at 390×844  (phone)   → fills ${(fillPhone * 100).toFixed(1)} %` +
        `  ${fillPhone <= 1 ? 'YES' : 'NO — CROPPED'}\n` +
        `  ⚠ It was 100×50: 84.2 % of its height and 73.4 % of its width in frame\n` +
        `    on a phone, i.e. cropped on three sides. See the note above.\n`,
    );
    // IN FRAME, on both viewports, on both axes. These are the assertions the
    // owner's decision exists to make true.
    expect(boardTop).toBeLessThan(topEdge);
    expect(boardBot).toBeGreaterThan(botEdge);
    expect(fillShot).toBeLessThan(1);
    expect(fillPhone).toBeLessThan(1);
    // GOLDENS, two-sided, so neither growing it back nor shrinking it to a
    // postage stamp passes. The phone is the binding viewport, at 90 %.
    expect(fillV).toBeCloseTo(0.2087, 4);
    expect(fillShot).toBeCloseTo(0.7413, 4);
    expect(fillPhone).toBeCloseTo(0.9014, 4);
    // The array is centred on the camera's own axis, and its sill clears the
    // plinth the surround stands it on.
    const r = rects();
    expect(Math.min(...r.map((p) => p.x0))).toBeCloseTo(-Math.max(...r.map((p) => p.x1)), 9);
  });

  it('idles LIT, not blank — an unpainted atlas is a black rectangle', () => {
    // The defect this exists for: a `CanvasTexture` over an unpainted canvas is
    // fully transparent, and an opaque `MeshBasicMaterial` ignores alpha. Every
    // scene that does not drive the board would show a 100 × 50 ft black hole in
    // dead centre field.
    const a = idleBoardArray(HARBOURFRONT);
    expect(a.main.kind).toBe('idle');
    expect(a.ribbon.items.length).toBeGreaterThan(0);
    // The label is the park's, not this module's — it invents no copy.
    expect(a.main.kind === 'idle' && a.main.label).toBe(HARBOURFRONT.name.toUpperCase());
  });
});

describe('the celebration chain reaches the tower', () => {
  const hr = {
    main: { kind: 'homeRun' as const, distFt: 441, evMph: 108, laDeg: 27, points: 214, chainX: 1.25 },
    left: null,
    right: null,
    strip: null,
    ribbon: { items: ['X'] },
  };
  const calm = { ...hr, main: { kind: 'idle' as const, label: 'X' } };
  const REST = 0.22;

  it('rests at the daylight row`s level and does not move', () => {
    for (const t of [0, 0.5, 3, 100]) {
      expect(towerState(calm, t, boardAnimFrame(calm.main, t), REST)).toEqual({
        level: REST,
        offsetV: 0,
      });
    }
  });

  it('flashes IN STEP with the board, on the board`s own frame number', () => {
    // ⚠ THE STROBE IS `strobeOn(frame)` — the SAME function that decides whether
    // the ribbon's ground is red and the board's word is white. The tower
    // therefore cannot drift out of step with them by construction, which is the
    // one thing a chain of three animations most wants to do.
    const levels: Array<{ f: number; level: number }> = [];
    for (let f = 0; f <= 12; f++) {
      levels.push({ f, level: towerState(hr, f / BOARD_ANIM_FPS, f, REST).level });
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — the tower's flash, ${BOARD_ANIM_FPS} Hz frames]\n` +
        levels
          .map((r) => `  frame ${String(r.f).padStart(2)}  level ${r.level.toFixed(3)}`)
          .join('\n') +
        `\n  rest ${REST}, flash ${TOWER_FLASH_LEVEL}, ${TOWER_SWEEPS_PER_LAP} sweeps per ` +
        `${RIBBON_SWEEP_S} s ring lap.\n`,
    );
    // It reaches the flash level, and it comes back down — a tower pinned ON is
    // not a flash, it is a brighter tower.
    expect(levels.some((r) => r.level === TOWER_FLASH_LEVEL)).toBe(true);
    expect(levels.some((r) => r.level < TOWER_FLASH_LEVEL)).toBe(true);
    // …and even the OFF frames are brighter than resting, so the tower reads as
    // involved throughout rather than blinking on a dark shaft.
    for (const r of levels) expect(r.level).toBeGreaterThan(REST);
  });

  it('the chase climbs, is QUANTISED, and laps with the ribbon', () => {
    const at = (t: number) => towerState(hr, t, boardAnimFrame(hr.main, t), REST).offsetV;
    expect(at(0)).toBe(0);
    // Negative offset pulls the map down past the strips, i.e. the pulse climbs.
    expect(at(0.5)).toBeLessThan(0);
    expect(at(1.0)).toBeLessThan(at(0.5));
    // Quantised at the SAME 60 Hz grid as the ribbon's scroll: two times inside
    // one bucket give the same offset, and the next bucket does not.
    expect(at(1.0)).toBe(at(1.0 + 0.9 / 60));
    expect(at(1.0)).not.toBe(at(1.0 + 1.1 / 60));
    // One ring lap = `TOWER_SWEEPS_PER_LAP` climbs of the tower. That tie is
    // what makes the three surfaces one event rather than three animations.
    expect(at(RIBBON_SWEEP_S)).toBeCloseTo(-TOWER_SWEEPS_PER_LAP, 6);
  });

  it('a non-finite or negative time is 0, not NaN', () => {
    // Reachable: the HUD latches `sinceS` from the scene clock and the renderer
    // subtracts, so a clock that has not started yet gives a negative `tS`. A
    // NaN offset would silently blank the strips' texture lookup.
    for (const t of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = towerState(hr, t, 0, REST);
      expect(Number.isFinite(s.offsetV)).toBe(true);
      expect(s.offsetV).toBe(0);
    }
  });
});
