// The shared tier policy, tested as a POLICY: the property under test is not
// "medium returns medium", it is "no automatic decision this module makes can
// ever cost more than the default". That is the rule `/GRAPHICS.md` §4 exists to
// enforce and the one `pickWaterQuality` broke.

import { describe, expect, it } from 'vitest';
import {
  isSceneTier,
  pickSceneQuality,
  SCENE_TIERS,
  withShadowMapSize,
  type SceneBudgetTable,
  type SceneQualityCaps,
} from './quality';

const TABLE: SceneBudgetTable = {
  low: { shadows: false, shadowMapSize: 512, pixelRatioCap: 1 },
  medium: { shadows: true, shadowMapSize: 1024, pixelRatioCap: 1.5 },
  high: { shadows: true, shadowMapSize: 2048, pixelRatioCap: 2 },
};

const caps = (c: SceneQualityCaps) => ({ capabilities: c });
const GOOD: SceneQualityCaps = { isWebGL2: true, maxTextureSize: 16384, precision: 'highp' };

describe('pickSceneQuality', () => {
  it('defaults to medium — never high — on a perfectly capable device', () => {
    // The anti-pattern in one assertion. This device reports every headroom
    // signal `pickWaterQuality` promotes on; it must still get the default.
    const q = pickSceneQuality(caps(GOOD), TABLE);
    expect(q.tier).toBe('medium');
    expect(q.shadowMapSize).toBe(1024);
    expect(q.reason).toMatch(/no measured evidence/);
  });

  it('steps DOWN on a WebGL1 context', () => {
    const q = pickSceneQuality(caps({ ...GOOD, isWebGL2: false }), TABLE);
    expect(q.tier).toBe('low');
    expect(q.reason).toMatch(/WebGL1/);
  });

  it('steps DOWN on a small maxTextureSize', () => {
    const q = pickSceneQuality(caps({ ...GOOD, maxTextureSize: 2048 }), TABLE);
    expect(q.tier).toBe('low');
    expect(q.reason).toMatch(/maxTextureSize 2048/);
  });

  it('steps DOWN when fragment precision is below highp', () => {
    const q = pickSceneQuality(caps({ ...GOOD, precision: 'mediump' }), TABLE);
    expect(q.tier).toBe('low');
    expect(q.reason).toMatch(/mediump/);
  });

  it('never returns a tier above the default without an explicit override', () => {
    // Sweep the capability space. NOTHING in it may reach `high`.
    for (const isWebGL2 of [true, false]) {
      for (const maxTextureSize of [1024, 4096, 8192, 16384, 32768]) {
        for (const precision of ['highp', 'mediump', 'lowp']) {
          const q = pickSceneQuality(caps({ isWebGL2, maxTextureSize, precision }), TABLE);
          expect(q.tier, JSON.stringify({ isWebGL2, maxTextureSize, precision })).not.toBe('high');
        }
      }
    }
  });

  it('honours ?quality= and says so', () => {
    for (const tier of SCENE_TIERS) {
      const q = pickSceneQuality(caps(GOOD), TABLE, tier);
      expect(q.tier).toBe(tier);
      expect(q).toMatchObject(TABLE[tier]);
      expect(q.reason).toBe(`forced by ?quality=${tier}`);
    }
  });

  it('ignores a junk override rather than throwing', () => {
    // A typo in a URL on someone's phone must not be a blank screen.
    expect(pickSceneQuality(caps(GOOD), TABLE, 'ultra').tier).toBe('medium');
    expect(pickSceneQuality(caps(GOOD), TABLE, '').tier).toBe('medium');
    expect(pickSceneQuality(caps(GOOD), TABLE, null).tier).toBe('medium');
  });

  it('treats absent capabilities as weak, not as capable', () => {
    // A renderer that answers nothing must not be read as headroom.
    expect(pickSceneQuality(caps({}), TABLE).tier).toBe('low');
  });
});

describe('withShadowMapSize', () => {
  it('is a debug hatch that may go UP, and annotates the reason', () => {
    const q = withShadowMapSize(pickSceneQuality(caps(GOOD), TABLE), 2048);
    expect(q.shadowMapSize).toBe(2048);
    expect(q.tier).toBe('medium');
    expect(q.reason).toMatch(/\?shadow=2048$/);
  });

  it('leaves the reason alone when the size already matches', () => {
    const base = pickSceneQuality(caps(GOOD), TABLE);
    expect(withShadowMapSize(base, 1024)).toEqual(base);
  });

  it('ignores a nonsense size', () => {
    const base = pickSceneQuality(caps(GOOD), TABLE);
    expect(withShadowMapSize(base, Number.NaN)).toEqual(base);
    expect(withShadowMapSize(base, -1)).toEqual(base);
  });
});

describe('isSceneTier', () => {
  it('accepts the three tiers and nothing else', () => {
    for (const t of SCENE_TIERS) expect(isSceneTier(t)).toBe(true);
    for (const v of ['ultra', '', null, undefined, 2, {}]) expect(isSceneTier(v)).toBe(false);
  });
});
