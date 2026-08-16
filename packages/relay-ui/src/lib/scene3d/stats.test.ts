import { describe, expect, it } from 'vitest';
import { makeFrameProbe, sampleSceneStats, shouldSampleStats } from './stats';
import type { SceneQuality } from './quality';

const QUALITY: SceneQuality = {
  tier: 'medium',
  shadows: true,
  shadowMapSize: 1536,
  pixelRatioCap: 2,
  reason: 'default (no measured evidence to promote on)',
};

const renderer = {
  info: {
    render: { calls: 41, triangles: 92_113 },
    memory: { geometries: 60, textures: 21 },
    programs: { length: 17 },
  },
};

describe('sampleSceneStats', () => {
  it('carries both the counters and the tier that explains them', () => {
    const s = sampleSceneStats(renderer, QUALITY, 30, 12.5);
    expect(s).toEqual({
      drawCalls: 41,
      triangles: 92_113,
      programs: 17,
      geometries: 60,
      textures: 21,
      tier: 'medium',
      shadows: true,
      shadowMapSize: 1536,
      pixelRatioCap: 2,
      qualityReason: 'default (no measured evidence to promote on)',
      frameMs: 12.5,
      frame: 30,
    });
  });

  it('survives a renderer with no program list', () => {
    const r = { info: { ...renderer.info, programs: null } };
    expect(sampleSceneStats(r, QUALITY, 3).programs).toBe(0);
    expect(sampleSceneStats(r, QUALITY, 3).frameMs).toBeNull();
  });
});

describe('makeFrameProbe', () => {
  it('reports nothing until the window fills', () => {
    const p = makeFrameProbe(4);
    // The first sample only starts the stopwatch: 4 window slots need 5 samples.
    for (let i = 0; i < 4; i++) {
      p.sample();
      expect(p.medianMs()).toBeNull();
    }
    p.sample();
    const m = p.medianMs();
    expect(m).not.toBeNull();
    // Wall-clock, so the VALUE is machine-dependent and untestable — that it is
    // a finite non-negative number is the whole contract.
    expect(Number.isFinite(m!)).toBe(true);
    expect(m!).toBeGreaterThanOrEqual(0);
  });
});

describe('shouldSampleStats', () => {
  it('emits an early sample for the harness, then every 30 frames', () => {
    // Frame 3, not 1: three uploads textures and compiles programs lazily on
    // first use, so frame 1 undercounts both.
    expect([1, 2, 4, 29, 31].filter(shouldSampleStats)).toEqual([]);
    expect([3, 30, 60, 90, 300].filter(shouldSampleStats)).toEqual([3, 30, 60, 90, 300]);
  });
});
