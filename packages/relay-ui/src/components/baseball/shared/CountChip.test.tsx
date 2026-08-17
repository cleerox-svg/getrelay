// @vitest-environment jsdom
//
// The derby scoreboard, asserted directly.
//
// ⚠ THIS FILE EXISTS BECAUSE A MUTATION SURVIVED. `CountChip` had no test of its
// own — BASEBALL.md already records that swapping its Score cell to
// `String(state.outs)` once failed 0 tests — and when the CHAIN cell landed, the
// same hole reappeared one cell to the left: pointing it at `chainMultiplier(
// curStreak)` instead of `chainMultiplier(curStreak + 1)`, i.e. reporting what
// the LAST home run earned rather than what the NEXT one would, failed 0 of 203.
// `DerbyGame.test.tsx` reads the chip through a mounted HUD and a 24-pitch
// session, which is the wrong instrument for "does this cell say the right
// number in this state": it can only reach the states a real session happens to
// pass through, and a chain of 5 is not one of them at every seed.
//
// So the chip is rendered directly against a synthetic `DerbyState`. Nothing
// here drives the sim, and nothing here re-derives a payout — `chainMultiplier`
// is imported and compared against LITERALS, so a change to the ramp is a
// failure here rather than a silently-agreeing recomputation.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CountChip } from './CountChip';
import type { DerbyState } from '../../../lib/baseball/derbyState';

afterEach(cleanup);

/** A `DerbyState` with only the fields the chip reads set to anything real. */
function state(over: Partial<DerbyState>): DerbyState {
  return {
    phase: 'ready',
    round: 1,
    rounds: 3,
    pitch: 1,
    pitchesPerRound: 8,
    pitchesThrown: 0,
    totalPitches: 24,
    outs: 0,
    strikes: 0,
    homeRuns: 0,
    barrels: 0,
    curStreak: 0,
    bestStreak: 0,
    roundScore: 0,
    score: 0,
    roundScores: [],
    bestFt: 0,
    reticle: { x: 0, h: 2.5 },
    pitchId: null,
    flightTimeS: 0,
    plate: null,
    last: null,
    roundsPlayed: 1,
    maxScore: 4000,
    ...over,
  };
}

/**
 * One cell of the chip, by its label. `Cell` renders `<span>{label}</span>` then
 * `<span>{value}</span>` inside one wrapper, so the value is the label's next
 * sibling — the same reader `DerbyGame.test.tsx` uses, kept identical on
 * purpose so the two cannot disagree about what a cell is.
 */
function cell(k: string): string {
  const label = screen.getByText(k);
  const value = label.nextElementSibling;
  expect(value, `no value beside the "${k}" cell`).toBeTruthy();
  return value!.textContent ?? '';
}

describe('CountChip — the derby scoreboard', () => {
  it('reports the sim’s own counters, unchanged', () => {
    render(
      <CountChip
        state={state({ round: 2, pitch: 5, outs: 3, homeRuns: 7, score: 1540, curStreak: 0 })}
      />,
    );
    expect(cell('Round')).toBe('2/3');
    expect(cell('Pitch')).toBe('5/8');
    expect(cell('Outs')).toBe('3');
    expect(cell('HR')).toBe('7');
    // Thousands separator: the owner's real session read 1,540.
    expect(cell('Score')).toBe((1540).toLocaleString());
  });

  it('⚠ the Chain cell counts the NEXT home run, not the last one', () => {
    // ⚠ THE OFF-BY-ONE THIS FILE WAS WRITTEN FOR. `curStreak` is the run BEFORE
    // the next swing, so at a streak of 2 the NEXT home run is the third — the
    // first one that earns anything — and the chip must already be lit. Reading
    // `chainMultiplier(curStreak)` instead shows ×1.00 there and ×1.25 only
    // after the multiplier has already been paid, which is a receipt, not a
    // reason to swing.
    const chainAt = (curStreak: number) => {
      cleanup();
      render(<CountChip state={state({ curStreak })} />);
      return cell('Chain');
    };
    // Below the threshold it counts UP toward it rather than printing ×1.00,
    // which is information the player can act on.
    expect(chainAt(0)).toBe('0/2');
    expect(chainAt(1)).toBe('1/2');
    // Two in a row ⇒ the next one is the third ⇒ the ramp is live.
    expect(chainAt(2)).toBe('×1.25');
    expect(chainAt(3)).toBe('×1.50');
    expect(chainAt(4)).toBe('×1.75');
    expect(chainAt(5)).toBe('×2.00');
    expect(chainAt(23)).toBe('×2.00');
  });

  it('tints the Chain cell only while it is earning', () => {
    // The tint is the whole visual difference between "counting up" and
    // "paying", and `Cell` only sets a colour when one is passed.
    cleanup();
    render(<CountChip state={state({ curStreak: 1 })} />);
    const cold = screen.getByText('Chain').nextElementSibling as HTMLElement;
    cleanup();
    render(<CountChip state={state({ curStreak: 2 })} />);
    const hot = screen.getByText('Chain').nextElementSibling as HTMLElement;
    expect(hot.style.color).not.toBe('');
    expect(cold.style.color).toBe('');
  });
});
