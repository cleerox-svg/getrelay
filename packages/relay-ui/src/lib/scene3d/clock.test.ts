// The scene clock is the foundation of the visual gate: if it can be frozen,
// two screenshot runs of the same scene are byte-identical, and only then can a
// PNG diff prove that a rendering change is (or isn't) a no-op. These tests
// pin the two properties everything else leans on — (1) untouched, it is a
// pass-through to wall time, so the shipped app is unaffected, and (2) engaged
// and frozen, the time a render loop sees stops moving.

import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_SCENE_STEP_MS,
  advanceSceneClock,
  disengageVirtualClock,
  engageVirtualClock,
  freezeSceneClock,
  isVirtualClock,
  resumeSceneClock,
  sceneClockPending,
  sceneNow,
  tickSceneClock,
} from './clock';

afterEach(() => disengageVirtualClock());

describe('scene clock — disengaged (what the shipped app gets)', () => {
  it('hands a render loop back the exact rAF timestamp it was given', () => {
    expect(isVirtualClock()).toBe(false);
    // Byte-identical pass-through matters: substituting performance.now() here
    // would silently shift every dt in the live game.
    expect(tickSceneClock(1234.5)).toBe(1234.5);
    expect(tickSceneClock(1250.5)).toBe(1250.5);
  });

  it('falls back to wall time when no timestamp is supplied', () => {
    const before = performance.now();
    const t = sceneNow();
    const after = performance.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('ignores freeze/advance — they only mean something once engaged', () => {
    freezeSceneClock();
    expect(tickSceneClock(99)).toBe(99);
    expect(tickSceneClock(100)).toBe(100);
  });
});

describe('scene clock — engaged', () => {
  it('advances one fixed step per tick and ignores the rAF timestamp', () => {
    engageVirtualClock(1000);
    expect(isVirtualClock()).toBe(true);
    // Wildly irregular real timestamps — the whole point is that they cannot
    // reach the scene.
    expect(tickSceneClock(50_000)).toBeCloseTo(1000 + DEFAULT_SCENE_STEP_MS, 9);
    expect(tickSceneClock(3)).toBeCloseTo(1000 + 2 * DEFAULT_SCENE_STEP_MS, 9);
  });

  it('honours a custom step so a harness can pick its own frame rate', () => {
    engageVirtualClock(0, 10);
    expect(tickSceneClock()).toBe(10);
    expect(tickSceneClock()).toBe(20);
  });

  it('sceneNow() reads without advancing', () => {
    engageVirtualClock(500, 10);
    expect(sceneNow()).toBe(500);
    expect(sceneNow()).toBe(500);
    expect(tickSceneClock()).toBe(510);
    expect(sceneNow()).toBe(510);
  });
});

describe('scene clock — frozen (the determinism guarantee)', () => {
  it('returns the same instant forever, so dt is 0 on every later frame', () => {
    engageVirtualClock(0, 10);
    tickSceneClock();
    tickSceneClock();
    freezeSceneClock();
    const frozen = sceneNow();
    let last = frozen;
    for (let i = 0; i < 200; i++) {
      const now = tickSceneClock(i * 1000); // real time galloping ahead
      expect(now).toBe(frozen);
      expect(now - last).toBe(0);
      last = now;
    }
    expect(sceneClockPending()).toBe(0);
  });
});

describe('scene clock — metered advance', () => {
  it('spends an exact slice one step at a time, then re-freezes', () => {
    engageVirtualClock(0, 10);
    freezeSceneClock();
    advanceSceneClock(25);
    expect(tickSceneClock()).toBe(10);
    expect(tickSceneClock()).toBe(20);
    // The remainder is a PARTIAL step: the slice must be spent exactly, or
    // "advance 150ms" would mean different amounts of motion at different
    // frame steps.
    expect(tickSceneClock()).toBe(25);
    expect(sceneClockPending()).toBe(0);
    expect(tickSceneClock()).toBe(25);
  });

  it('queues additive slices and ignores non-positive ones', () => {
    engageVirtualClock(0, 10);
    freezeSceneClock();
    advanceSceneClock(10);
    advanceSceneClock(10);
    advanceSceneClock(-5);
    advanceSceneClock(Number.NaN);
    expect(sceneClockPending()).toBe(20);
    tickSceneClock();
    tickSceneClock();
    expect(sceneClockPending()).toBe(0);
    expect(sceneNow()).toBe(20);
  });

  it('resume lifts the budget back to unlimited', () => {
    engageVirtualClock(0, 10);
    freezeSceneClock();
    expect(sceneClockPending()).toBe(0);
    resumeSceneClock();
    expect(sceneClockPending()).toBe(Infinity);
    expect(tickSceneClock()).toBe(10);
  });
});
