// Golf's budget table, tested for the one property a table can get wrong in a
// way nothing else catches: **a tier that raises a scene's cost.**
//
// The plan that produced this table originally said "default 1536² everywhere".
// Two of the three scenes were at 2048², so that reads as a step down — but
// PuttGL was already at 1024², and a flat 1536² default would have made a
// currently-safe scene 2.25× more expensive in shadow-map memory. The assertions
// below are what stop that from being reintroduced by a later "let's simplify
// this to one number" edit.

import { describe, expect, it } from 'vitest';
import { pickSceneQuality, SCENE_TIERS } from '../../../lib/scene3d/quality';
import { GOLF_SCENE_BUDGETS, SHADOW_OVERRIDE_SIZES, SHIPPED_SHADOW_MAP_SIZE, type GolfSceneId } from './quality';

const SCENES = Object.keys(GOLF_SCENE_BUDGETS) as GolfSceneId[];
const CAPABLE = { capabilities: { isWebGL2: true, maxTextureSize: 16384, precision: 'highp' } };

describe('golf scene budgets', () => {
  it('covers exactly the three scenes that own a renderer', () => {
    expect(SCENES.sort()).toEqual(['course', 'putt', 'range']);
  });

  it('never exceeds what the scene ships today, at ANY tier', () => {
    const over: string[] = [];
    for (const scene of SCENES) {
      for (const tier of SCENE_TIERS) {
        const got = GOLF_SCENE_BUDGETS[scene][tier].shadowMapSize;
        const cap = SHIPPED_SHADOW_MAP_SIZE[scene];
        if (got > cap) over.push(`${scene}.${tier}: ${got}² > shipped ${cap}²`);
        if (GOLF_SCENE_BUDGETS[scene][tier].pixelRatioCap > 2) {
          over.push(`${scene}.${tier}: pixelRatioCap > 2`);
        }
      }
    }
    expect(over, `a tier must never RAISE a scene's cost: ${over.join(', ')}`).toEqual([]);
  });

  it('is monotonic in cost: low ≤ medium ≤ high on every dial', () => {
    for (const scene of SCENES) {
      const t = GOLF_SCENE_BUDGETS[scene];
      expect(t.low.shadowMapSize).toBeLessThanOrEqual(t.medium.shadowMapSize);
      expect(t.medium.shadowMapSize).toBeLessThanOrEqual(t.high.shadowMapSize);
      expect(t.low.pixelRatioCap).toBeLessThanOrEqual(t.medium.pixelRatioCap);
      expect(t.medium.pixelRatioCap).toBeLessThanOrEqual(t.high.pixelRatioCap);
      expect(Number(t.low.shadows)).toBeLessThanOrEqual(Number(t.medium.shadows));
      expect(Number(t.low.ibl)).toBeLessThanOrEqual(Number(t.medium.ibl));
      expect(Number(t.medium.ibl)).toBeLessThanOrEqual(Number(t.high.ibl));
    }
  });

  it('keeps scene-wide IBL OFF at low, in every scene', () => {
    // `scenery.ts` attached its PMREM to the ball alone so "turf/trees/water pay
    // no per-frame env cost". Turning that on everywhere would silently reverse
    // a considered decision on exactly the hardware it was made for — the same
    // class of mistake as a tier that raises a shadow map. `low` is where the
    // old behaviour is preserved, so it is asserted rather than remembered.
    for (const scene of SCENES) {
      expect(GOLF_SCENE_BUDGETS[scene].low.ibl, `${scene}.low`).toBe(false);
      expect(GOLF_SCENE_BUDGETS[scene].medium.ibl, `${scene}.medium`).toBe(true);
    }
  });

  it('turns the dial GOLF.md nominates: Course and Range 2048² → 1536², Putt stays 1024²', () => {
    const resolved = Object.fromEntries(
      SCENES.map((s) => [s, pickSceneQuality(CAPABLE, GOLF_SCENE_BUDGETS[s]).shadowMapSize]),
    );
    expect(resolved).toEqual({ course: 1536, range: 1536, putt: 1024 });
  });

  it('does not let `high` raise the shadow map in any scene', () => {
    // `high` buys pixel ratio, never shadow resolution. Reproducing the
    // configuration that killed the WebView GPU process is `?shadow=2048`'s job:
    // an explicit, per-load, per-handset act, not something a tier hands out.
    for (const scene of SCENES) {
      const t = GOLF_SCENE_BUDGETS[scene];
      expect(t.high.shadowMapSize).toBe(t.medium.shadowMapSize);
    }
  });

  it('every scene defaults to medium on capable hardware', () => {
    for (const scene of SCENES) {
      expect(pickSceneQuality(CAPABLE, GOLF_SCENE_BUDGETS[scene]).tier).toBe('medium');
    }
  });

  it('offers the crash configuration only through the ?shadow= allowlist', () => {
    expect([...SHADOW_OVERRIDE_SIZES]).toEqual([1024, 1536, 2048]);
  });
});
