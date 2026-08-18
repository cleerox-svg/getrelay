// @vitest-environment jsdom
//
// THE BUG THIS PINS. An equipped ball skin is a MATERIAL COLOUR, and all three
// golf renderers baked it exactly once, at scene-build time, out of a ref read
// inside a `useEffect(..., [])`:
//
//     const cosmeticsRef = useRef(cosmetics);
//     cosmeticsRef.current = cosmetics;               // tracks the prop fine
//     useEffect(() => {
//       const ballMat = makeBallMaterial(tex, cosmeticsRef.current?.ball);
//       ...
//     }, []);                                          // ← read ONCE, ever
//
// Nothing wrote `ballMat.color` afterwards and `cosmetics` appeared in no
// dependency array in `components/golf`, so the equipped skin applied only if
// the economy's cosmetics slice happened to be 'ready' at the instant the GL
// component mounted, and an equip performed while the scene was alive could
// never take effect. The trail/tracer material had the identical shape.
//
// The fix is `useGolfSkin` in ./skin.ts: the scene REGISTERS its ball + tracer
// materials once (which applies the skin synchronously, so the very first
// rendered frame is right) and the hook re-applies on every `cosmetics` change
// — no rebuild, no dispose, no lost mid-shot state.
//
// Two halves are tested, and both were broken:
//   1. BEHAVIOUR — the seam re-skins a material that is already built, both
//      when the slice resolves late and when the player equips mid-round.
//   2. WIRING — each of the three `*GL.tsx` scenes actually goes through the
//      seam and no longer bakes a cosmetic out of a ref. There is no way to
//      mount a `*GL.tsx` here (jsdom has no WebGL and no 2-D canvas, so both
//      `WebGLRenderer` and `makeDimpleNormalMap` throw), so the wiring is
//      asserted against the source. Without it, half a fix — one renderer
//      converted, two left baking — would pass silently.

import { describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { makeBallMaterial } from '../../../lib/golf/ballTexture';
import { resolveGolfCosmetics, type GolfCosmetics } from '../../../lib/golf/cosmetics';
import type { Cosmetic, EquippedCosmetics } from '../../../lib/types';
import { applyGolfSkin, useGolfSkin, type GolfSkinTargets } from './skin';

// Real catalog rows, copied from the worker's CATALOG (economy.ts) so the
// colours under test are the ones a player actually buys.
const CATALOG: Cosmetic[] = [
  { id: 'ball_classic', slot: 'ball', name: 'Classic White', rarity: 'common', price: 0, visual: { color: '#F5F5F5', metalness: 0, roughness: 0.45 } },
  { id: 'ball_sunset', slot: 'ball', name: 'Sunset', rarity: 'common', price: 200, visual: { color: '#FF7043', metalness: 0, roughness: 0.4 } },
  { id: 'ball_gold', slot: 'ball', name: 'Gold', rarity: 'epic', price: 2000, visual: { color: '#FFD700', metalness: 0.85, roughness: 0.18 } },
  { id: 'trail_none', slot: 'trail', name: 'None', rarity: 'common', price: 0, visual: { color: '#FFFFFF' } },
  { id: 'trail_aqua', slot: 'trail', name: 'Aqua', rarity: 'rare', price: 800, visual: { color: '#00E5FF' } },
];

const DEFAULT_EQUIPPED: EquippedCosmetics = {
  ball: 'ball_classic',
  trail: 'trail_none',
  frame: 'frame_none',
};

function equip(part: Partial<EquippedCosmetics>): GolfCosmetics {
  return resolveGolfCosmetics(CATALOG, { ...DEFAULT_EQUIPPED, ...part });
}

/** What the economy hands a scene before the /economy/cosmetics fetch lands. */
const UNRESOLVED = resolveGolfCosmetics([], DEFAULT_EQUIPPED);

// The Range's stock tracer red and the Course's white. Each scene BUILDS its
// tracer in its own colour; that is what an un-equipped trail must revert to,
// so a seam that restored one fixed colour would repaint the other scene's line.
const RANGE_TRACER = 0xff4d4d;
const COURSE_TRACER = 0xffffff;

interface Built {
  ball?: THREE.MeshStandardMaterial;
  trail?: THREE.LineBasicMaterial;
}

/**
 * A stand-in for a `*GL.tsx` scene with the SAME lifecycle shape: one
 * mount-once build effect that creates the materials and hands them to the
 * seam. Everything the real scenes do around it (renderer, geometry, rAF loop)
 * is irrelevant to the skin and unavailable in jsdom.
 */
function Scene({
  cosmetics,
  out,
  stock = RANGE_TRACER,
}: {
  cosmetics?: GolfCosmetics;
  out: Built;
  stock?: number;
}) {
  const registerSkin = useGolfSkin(cosmetics);
  useEffect(() => {
    const ball = makeBallMaterial(new THREE.Texture());
    const trail = new THREE.LineBasicMaterial({ color: stock });
    out.ball = ball;
    out.trail = trail;
    registerSkin({ ball, trail });
    return () => {
      ball.dispose();
      trail.dispose();
    };
    // Mount-once, exactly like the real build effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function mount(cosmetics?: GolfCosmetics, stock = RANGE_TRACER) {
  const out: Built = {};
  const view = render(<Scene cosmetics={cosmetics} out={out} stock={stock} />);
  return {
    out,
    rerender: (next?: GolfCosmetics) =>
      view.rerender(<Scene cosmetics={next} out={out} stock={stock} />),
  };
}

const ballHex = (out: Built) => out.ball!.color.getHexString();
const trailHex = (out: Built) => out.trail!.color.getHexString();

describe('golf cosmetics apply to a scene that is already built', () => {
  it('re-skins the ball when the cosmetics slice resolves AFTER the build', () => {
    // Mount while /economy/cosmetics is still in flight: empty catalog, default
    // equip → no override, stock white ball.
    const { out, rerender } = mount(UNRESOLVED);
    expect(ballHex(out)).toBe('ffffff');

    // The fetch lands and the player's real equip arrives.
    rerender(equip({ ball: 'ball_gold' }));
    expect(ballHex(out)).toBe('ffd700');
    expect(out.ball!.metalness).toBeCloseTo(0.85, 6);
    expect(out.ball!.roughness).toBeCloseTo(0.18, 6);
  });

  it('re-skins the tracer when the cosmetics slice resolves AFTER the build', () => {
    const { out, rerender } = mount(UNRESOLVED);
    expect(trailHex(out)).toBe('ff4d4d');

    rerender(equip({ trail: 'trail_aqua' }));
    expect(trailHex(out)).toBe('00e5ff');
  });

  it('changes the ball when the player equips a different skin mid-round', () => {
    const { out, rerender } = mount(equip({ ball: 'ball_sunset' }));
    expect(ballHex(out)).toBe('ff7043');

    rerender(equip({ ball: 'ball_gold' }));
    expect(ballHex(out)).toBe('ffd700');
    expect(out.ball!.metalness).toBeCloseTo(0.85, 6);
  });

  it('changes the tracer when the player equips a different trail mid-round', () => {
    const { out, rerender } = mount(equip({ trail: 'trail_aqua', ball: 'ball_gold' }));
    expect(trailHex(out)).toBe('00e5ff');

    // Ball untouched, trail swapped: the two halves are independent.
    rerender(equip({ trail: 'trail_none', ball: 'ball_gold' }));
    expect(ballHex(out)).toBe('ffd700');
    expect(trailHex(out)).toBe('ff4d4d');
  });

  it('restores the stock look when the skin is un-equipped', () => {
    const { out, rerender } = mount(equip({ ball: 'ball_gold', trail: 'trail_aqua' }));
    expect(ballHex(out)).toBe('ffd700');

    rerender(equip({}));
    // Not the catalog's #F5F5F5: ball_classic is "no skin", so every field goes
    // back to the material's own stock value, not to a catalog row.
    expect(ballHex(out)).toBe('ffffff');
    expect(out.ball!.roughness).toBeCloseTo(0.3, 6);
    expect(out.ball!.metalness).toBeCloseTo(0.02, 6);
    expect(trailHex(out)).toBe('ff4d4d');
  });

  it("restores THAT scene's stock tracer, not a shared default", () => {
    // Same un-equip, a scene whose line is white (the Course) rather than red.
    const { out, rerender } = mount(equip({ trail: 'trail_aqua' }), COURSE_TRACER);
    expect(trailHex(out)).toBe('00e5ff');
    rerender(equip({}));
    expect(trailHex(out)).toBe('ffffff');
  });

  it('treats the DEFAULT equip as no skin at all, at build and on update', () => {
    // Guards the "is this the default skin" check in resolveGolfCosmetics from
    // being inverted: ball_classic carries a colour (#F5F5F5) that is NOT the
    // stock ball, so a scene that applied it would visibly dull the ball.
    const { out, rerender } = mount(equip({}));
    expect(ballHex(out)).toBe('ffffff');
    rerender(equip({}));
    expect(ballHex(out)).toBe('ffffff');
  });

  it('applies the skin synchronously at registration, before any frame', () => {
    // The scenes render their first frame inside the build effect, so the seam
    // must skin at register() time — not only from the update effect.
    const mat = makeBallMaterial(new THREE.Texture());
    applyGolfSkin({ ball: mat }, equip({ ball: 'ball_gold' }));
    expect(mat.color.getHexString()).toBe('ffd700');
  });

  it('tolerates a scene with no tracer and an unregistered scene', () => {
    const targets: GolfSkinTargets = {};
    expect(() => applyGolfSkin(targets, equip({ ball: 'ball_gold' }))).not.toThrow();
    const mat = makeBallMaterial(new THREE.Texture());
    expect(() => applyGolfSkin({ ball: mat }, undefined)).not.toThrow();
    expect(mat.color.getHexString()).toBe('ffffff');
  });
});

// --- Wiring: all three renderers, one seam -------------------------------

const GL = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(GL, f), 'utf8');

describe('every golf renderer goes through the shared skin seam', () => {
  for (const file of ['CourseGL.tsx', 'RangeGL.tsx', 'PuttGL.tsx']) {
    it(`${file} registers its materials with useGolfSkin`, () => {
      const src = read(file);
      expect(src).toContain('useGolfSkin(');
      expect(src).toContain('registerSkin(');
    });

    it(`${file} does not bake a cosmetic out of a ref at build time`, () => {
      // The exact shape of the bug: a ref snapshot read inside the `[]` build
      // effect. If this comes back, the scene is frozen at mount again.
      const src = read(file);
      expect(src).not.toContain('cosmeticsRef');
    });
  }

  for (const file of ['CourseGL.tsx', 'RangeGL.tsx']) {
    it(`${file} registers its tracer, not just its ball`, () => {
      // The trail half is half the cosmetic. Registering only the ball would
      // leave every equipped tracer colour dead in both 3-D scenes.
      expect(read(file)).toMatch(/registerSkin\(\{[^}]*trail:/);
    });
  }
});
