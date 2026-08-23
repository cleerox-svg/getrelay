// THE DUEL'S VOCABULARY — eight outcomes, and the ones that read differently
// because the plate appearance ended on them.
//
// ⚠ WHY THIS IS NOT COVERED BY THE BOARD'S TEST. `duelBoard.test.ts` asserts
// that the board's line is `describePitch(rec)` VERBATIM, which is a claim about
// the board and is tautological about the copy: every string this file could
// possibly return would satisfy it. The wording itself needs its own assertions,
// and the ones with teeth are the pairs — the same pitch outcome reading two
// ways depending on `record.pa`.

import { describe, expect, it } from 'vitest';
import type { PitchRecord } from '../../../lib/baseball/duelState';
import { basesLabel, describePitch, toneOfPitch } from './duelCopy';

/** A record with only the fields the copy reads made meaningful. */
const rec = (over: Partial<PitchRecord>): PitchRecord =>
  ({
    outcome: 'ball',
    play: null,
    swung: false,
    distFt: 0,
    fielder: '',
    pa: null,
    ...over,
  }) as unknown as PitchRecord;

const pa = (outcome: string, runs = 0, battingTeam = 'away') =>
  ({ outcome, runs, battingTeam }) as unknown as PitchRecord['pa'];

describe('duelCopy — the plate appearance outranks the pitch', () => {
  it('⚠ THE SAME PITCH READS TWO WAYS, and only `record.pa` decides which', () => {
    // The three pairs. Re-deriving "was that the third strike?" from
    // `strikesAfter` in a HUD would be a second copy of `duelInnings.countAfter`
    // — and it would be wrong on the two-strike foul, which adds no strike.
    expect(describePitch(rec({ outcome: 'ball' }))).toBe('Ball');
    expect(describePitch(rec({ outcome: 'ball', pa: pa('walk') }))).toBe('Ball four — walk');

    expect(describePitch(rec({ outcome: 'calledStrike' }))).toBe('Called strike');
    expect(describePitch(rec({ outcome: 'calledStrike', pa: pa('strikeout') }))).toBe(
      'Strikeout looking',
    );

    expect(describePitch(rec({ outcome: 'swingingStrike' }))).toBe('Swing and a miss');
    expect(describePitch(rec({ outcome: 'swingingStrike', pa: pa('strikeout') }))).toBe(
      'Strikeout swinging',
    );

    // …and a foul is a foul at every count, which is the one that must NOT pair.
    expect(describePitch(rec({ outcome: 'foul' }))).toBe('Foul ball');
    expect(describePitch(rec({ outcome: 'foul', pa: null }))).toBe('Foul ball');
  });

  it('a ball in play says what `fielding.ts` said it was', () => {
    const inPlay = (play: string, distFt: number, fielder = '') =>
      describePitch(rec({ outcome: 'inPlay', play: play as never, distFt, fielder }));
    expect(inPlay('HR', 421.4)).toBe('GONE! 421 ft');
    expect(inPlay('TRIPLE', 388)).toBe('Triple — 388 ft');
    expect(inPlay('DOUBLE', 341.6)).toBe('Double — 342 ft');
    expect(inPlay('SINGLE', 154)).toBe('Base hit — 154 ft');
    expect(inPlay('FOUL', 90)).toBe('Foul ball');
    // ⚠ THE FIELDER IS NAMED BECAUSE THE SIM NAMED HIM — never invented from a
    // spray angle here.
    expect(inPlay('OUT', 300, 'CF')).toBe('Out — CF');
    expect(inPlay('OUT', 300, '')).toBe('Out — 300 ft');
  });

  it('runs driven in are appended, singular and plural, and never on a 0', () => {
    const hr = (runs: number) =>
      describePitch(rec({ outcome: 'inPlay', play: 'HR', distFt: 400, pa: pa('homeRun', runs) }));
    expect(hr(1)).toBe('GONE! 400 ft · 1 run');
    expect(hr(3)).toBe('GONE! 400 ft · 3 runs');
    // A solo out drives nothing in, and `· 0 runs` would be true and useless.
    expect(hr(0)).toBe('GONE! 400 ft');
  });

  it('⚠ THE TONE MIRRORS WITH THE ROLE — the same record reads opposite ways', () => {
    const hr = rec({ outcome: 'inPlay', play: 'HR', distFt: 430 });
    const k = rec({ outcome: 'swingingStrike', pa: pa('strikeout') });
    const ball = rec({ outcome: 'ball' });
    const out = rec({ outcome: 'inPlay', play: 'OUT', fielder: 'SS' });

    expect(toneOfPitch(hr, true)).toBe('gone');
    expect(toneOfPitch(hr, false)).toBe('miss');
    expect(toneOfPitch(k, true)).toBe('miss');
    expect(toneOfPitch(k, false)).toBe('good');
    expect(toneOfPitch(ball, true)).toBe('good');
    expect(toneOfPitch(ball, false)).toBe('miss');
    expect(toneOfPitch(out, true)).toBe('miss');
    expect(toneOfPitch(out, false)).toBe('good');
    // A foul is nobody's, in either direction.
    const foul = rec({ outcome: 'foul' });
    expect(toneOfPitch(foul, true)).toBe('neutral');
    expect(toneOfPitch(foul, false)).toBe('neutral');
  });

  it('the base label fits the five characters the column has', () => {
    expect(basesLabel([false, false, false])).toBe('—');
    expect(basesLabel([true, false, false])).toBe('1');
    expect(basesLabel([false, true, true])).toBe('2-3');
    expect(basesLabel([true, true, true])).toBe('1-2-3');
    // The widest case is the budget, so the claim is arithmetic rather than an
    // eyeball: `boardState.BoardSide` records 5.4 characters at the floor.
    expect(basesLabel([true, true, true]).length).toBeLessThanOrEqual(5);
  });
});
