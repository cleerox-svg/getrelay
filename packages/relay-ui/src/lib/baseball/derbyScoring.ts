// Home Run Derby — the PAYOUT, and nothing else.
//
// Split out of `derbyRules.ts` at the 500-line cap — EXTRACTION, NOT A RAISED
// CAP. It imports NOTHING from the rest of the game, so it is the LEAF of the
// derby's module graph: `derbyRules` (the format) imports it, never the other
// way round, which is what lets `validateDerbyFormat` check the payout against
// the format's own per-pitch cap with no cycle to reason about. The cap is a
// REQUIRED argument here rather than a default read off a constant, for the same
// reason: the ceiling is the FORMAT's number, and a scorer that knows it is a
// scorer that can drift from it.
//
// ⚠ WHY THIS FILE GREW A SECOND SCORER, MEASURED. M2 shipped with
// `homeRunPoints` as the ONLY scorer, and the owner played it and said "it's
// tough to hit, I can't get the timing right". Headless measurement said it was
// not them. Two rows from that review — 40 sessions each, reticle at zone
// centre, tap exactly on the true plate crossing:
//
//     reticleX 0.0 ft   HR 54 % · inPlay 46 % · mean carry 406.7 ft
//                       → 46 % of swings carried 400 ft and paid ZERO,
//                         byte-identical to a whiff
//     tap +45 ms wall   HR  0 % · foul 95 %  · score 0
//                       → the player still made contact on 95 % of them and
//                         the game said nothing happened
//
// So the payout now scores CONTACT, continuously, and the home run is a bonus on
// top of it rather than the whole board. That is also the fix for the timing
// cliff: at +45 ms of wall clock the swing still MEETS the ball, so a payout
// that reads the STRIKE rather than the OUTCOME turns a cliff into a slope
// without touching one physics number.
//
// ⚠ AND THE HARD CONSTRAINT THAT SHAPES EVERY NUMBER BELOW.
// `packages/relay-worker/src/games.ts` REJECTS (400, never truncates) a
// submission whose score exceeds `rounds × MAX_POINTS_PER_ROUND`, and
// `DerbyGame.bank()` swallows the 400 with `.catch(() => undefined)` — so an
// over-cap score vanishes silently with NO UI signal. M2c shipped exactly that
// bug once (via `bestStreak`) and it took mutation testing against the real
// worker to find it. The invariant is therefore held STRUCTURALLY and for EVERY
// outcome, not just for home runs: `swingPoints` is the ONE entry point, it is
// the ONE place the clamp is applied, and `validateDerbyPayout` asserts the
// clamp by looping over the outcome ENUM at inputs no physics can reach — so
// "somebody adds a payout for a sixth outcome and forgets the cap" is a test
// failure rather than a silently-lost score.

/**
 * The whole enum, as data, so a new outcome cannot be added untested.
 *
 * ⚠ THE ARRAY IS THE SOURCE AND THE TYPE IS DERIVED FROM IT — that order, and it
 * matters. This shipped the other way round for one review cycle: a hand-written
 * union plus `const DERBY_OUTCOMES: readonly DerbyOutcome[]`, which accepts any
 * SUBSET of the union. Measured by the reviewer: deleting `'whiff'` from the
 * array left 182/182 green and `pnpm typecheck` at exit 0, because
 * `validatePayoutCap`, `validateDerbyPayout`'s cap leg and both of
 * `derbySim.test.ts`'s outcome loops all silently shrank together — so the loop
 * below claimed to be a loop over the enum while actually being a loop over
 * whatever list somebody last remembered to extend. With `as const` + `typeof`,
 * a member can only join the union by joining the loop, and dropping one is a
 * type error at every `case`/comparison that still names it.
 */
export const DERBY_OUTCOMES = ['homeRun', 'inPlay', 'foul', 'whiff', 'take'] as const;

/**
 * How one swing ended. `resolveFence`'s five-way answer, folded to the format.
 *
 * It lives HERE rather than in `derbyRules.ts` because it is exactly the domain
 * of `swingPoints`. Putting the union beside the function that must be total
 * over it is what makes "every outcome is capped" expressible as a loop instead
 * of as a list somebody has to remember to extend — and DERIVING it from that
 * loop's own array is what makes the sentence true rather than aspirational.
 */
export type DerbyOutcome = (typeof DERBY_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// The home run — every number unchanged from M2
// ---------------------------------------------------------------------------

/** Points for clearing the wall at all. FEEL KNOB. */
export const HR_BASE_POINTS = 100;

/**
 * Where the home-run distance bonus starts, ft. FEEL KNOB pinned to park data:
 * the shortest home run this game can produce is down a foul line, and the
 * shortest sampled fence in `PARKS` is 328 ft, so a datum at 350 pays every home
 * run something and pays a wall-scraper almost nothing.
 */
export const DISTANCE_DATUM_FT = 350;

/** Points per foot of projected carry past the datum. FEEL KNOB. */
export const POINTS_PER_FT = 1;

// ---------------------------------------------------------------------------
// Solid contact — the new half
// ---------------------------------------------------------------------------

/**
 * Where in-play carry starts paying, ft. FEEL KNOB, nominated from the FIELD
 * rather than from taste: the skinned infield's grass line is 155.5 ft at dead
 * centre — `fielding.infieldDepthFt(0)` = `RUBBER_D_FT + INFIELD_ARC_FT` =
 * 60.5 + 95 — so a ball that never reaches the outfield grass is not solid
 * contact and pays nothing.
 *
 * Quoted rather than imported: `derbySim` deliberately does not depend on
 * `fielding.ts`, because a derby has no defence. `derbySim.test.ts` asserts the
 * two agree, so a change to the arc is a test failure here rather than a silent
 * payout change.
 */
export const CONTACT_DATUM_FT = 155.5;

/**
 * Points per foot of carry past `CONTACT_DATUM_FT` for a ball that stays in the
 * park. FEEL KNOB, sized AGAINST `POINTS_PER_FT` by one ratio: a fly ball caught
 * on the centre-field track is worth about HALF the home run it just missed.
 *
 *   400 ft, caught   0.35 × (400 − 155.5) =  86 pts
 *   400 ft, gone     100  + (400 − 350)   = 150 pts
 *   250 ft, caught   0.35 × ( 94.5)       =  33 pts
 *   160 ft, caught   0.35 × (  4.5)       =   2 pts
 *
 * ⚠ IT MUST STAY BELOW THE HOME-RUN CURVE AT EVERY CARRY, or the game pays more
 * for missing the wall than for clearing it and the scoreboard teaches the
 * opposite of the sport. `validateDerbyPayout` asserts that as an inequality
 * swept over the whole range, not at the one point this comment quotes: the two
 * curves have different slopes AND different datums, so a spot check proves
 * nothing about where they cross.
 */
export const CONTACT_POINTS_PER_FT = 0.35;

/**
 * What a FOUL is worth, as a fraction of the SAME BALL HIT FAIR. FEEL KNOB.
 *
 * A foul is not a different quality of contact — it is the same collision with
 * the spray angle past 45°, and at +45 ms of wall clock it is what 95 % of
 * swings produce. Paying a quarter of what that ball would have paid in play is
 * what converts the row from "identical to a whiff" into "you got the barrel to
 * it, you were late" — the slope the timing cliff did not have. A quarter and
 * not a half because a foul is still a wasted pitch: it must never be worth
 * playing for.
 *
 * ⚠ WHAT IS ASSERTED, RATHER THAN CLAIMED. This comment used to say
 * "`derbySim.test.ts` measures the all-foul session against a real one to say by
 * how much"; no such measurement existed, and this project's convention is that
 * a comment's claim is asserted. The two that ARE: `derbySim.test.ts` checks the
 * identity `foul(c) = round(0.25 × inPlay_unrounded(c))` at every carry from 0
 * to 500 ft, and `validateDerbyPayout` sweeps `foul < inPlay` — STRICTLY,
 * wherever the fair ball pays anything at all — from 0 to 700 ft at both barrel
 * states. Together they say a foul is the same ball at a quarter of the money,
 * which is the claim; the session-level figure was never measured and is not
 * asserted here.
 *
 * It scales the WHOLE fair payout, barrel bonus included, which is what makes
 * the identity above literally true of the code.
 */
export const FOUL_CREDIT_FRACTION = 0.25;

/**
 * Flat bonus for a BARREL. FEEL KNOB on a PUBLISHED classification —
 * `tuning.isBarrel` is Statcast's window and is never widened to make the derby
 * generous, so this is a payout attached to an external yardstick rather than a
 * yardstick bent to a payout.
 *
 * It exists because the charter's brief for this pass says barrels are worth
 * more, and because it is the one term that rewards the STRIKE independently of
 * where the ball happened to land — which is the difference between a scoreboard
 * that teaches "hit it hard at the right angle" and one that teaches "get lucky
 * with the bearing".
 */
export const BARREL_BONUS_POINTS = 25;

/** The home-run curve. UNCLAMPED — `swingPoints` is the one place that clamps. */
function homeRunCredit(carryFt: number): number {
  return HR_BASE_POINTS + Math.max(0, carryFt - DISTANCE_DATUM_FT) * POINTS_PER_FT;
}

/** The solid-contact curve, for a ball that stayed in the park. Unclamped. */
function contactCredit(carryFt: number): number {
  return Math.max(0, carryFt - CONTACT_DATUM_FT) * CONTACT_POINTS_PER_FT;
}

/**
 * ⚠ THE ONE SCORER. Every point this game pays comes through here, so the
 * per-pitch cap is applied ONCE, to EVERY outcome, and the round invariant
 * (`pitchesPerRound × cap ≡ MAX_POINTS_PER_ROUND`) survives any payout change
 * that goes through this function.
 *
 * ⚠ NaN IS CLAMPED TOO, and that is not defensive noise: `carryFt` arrives from
 * an integrator, and a NaN score would propagate through `commit()` into
 * `submitGameScore`, fail the worker's `Number.isInteger` and be dropped
 * silently, because the 400 is swallowed by a `.catch`.
 */
export function swingPoints(
  outcome: DerbyOutcome,
  carryFt: number,
  barrel: boolean,
  cap: number,
): number {
  if (outcome === 'whiff' || outcome === 'take') return 0;
  const carry = Number.isFinite(carryFt) ? carryFt : 0;
  // What this ball is worth HIT FAIR. A foul is not a separate curve; it is this
  // one, scaled — see `FOUL_CREDIT_FRACTION`.
  let fair = outcome === 'homeRun' ? homeRunCredit(carry) : contactCredit(carry);
  if (barrel) fair += BARREL_BONUS_POINTS;
  const raw = outcome === 'foul' ? fair * FOUL_CREDIT_FRACTION : fair;
  return Math.min(cap, Math.max(0, Math.round(raw)));
}

// ⚠ THERE IS NO `homeRunPoints` ANY MORE, and that is rule 10 (delete on
// supersede) rather than an oversight. M2 exported one and it survived this pass
// for a while as `swingPoints('homeRun', …)` with a name — at which point it was
// a second way to spell the same call, i.e. exactly the "one implementation per
// concept" hazard, and every call site had already moved. Git has it.

/** The extreme carries the cap check probes. Two are unreachable on purpose. */
const PROBE_CARRIES = [
  Number.NEGATIVE_INFINITY,
  -1e9,
  Number.NaN,
  0,
  100,
  CONTACT_DATUM_FT,
  300,
  DISTANCE_DATUM_FT,
  400,
  500,
  1e9,
  Number.MAX_SAFE_INTEGER,
  Number.POSITIVE_INFINITY,
];

/**
 * THE WORKER'S INVARIANT, over the whole outcome enum. Cheap — a few dozen
 * arithmetic calls — because `derbyRules.validateDerbyFormat` calls it on the
 * LIVE config path, where it is the one payout property that actually depends on
 * the config (`cap` is `MAX_POINTS_PER_ROUND / pitchesPerRound`).
 *
 * ⚠ IT IS A LOOP OVER `DERBY_OUTCOMES`, NOT A LIST — and that is only true
 * because `DerbyOutcome` is DERIVED from that array (see its declaration).
 * Before the M2 feel pass this was a single line —
 * `homeRunPoints(MAX_SAFE_INTEGER) > cap` — which was sufficient only while home
 * runs were the only thing that scored. The failure it now guards is "somebody
 * adds a payout for a sixth outcome and forgets the cap", and a hand-written
 * list of the outcomes that happen to score today cannot see that.
 */
export function validatePayoutCap(cap: number): string[] {
  const bad: string[] = [];
  if (!(cap > 0) || !Number.isInteger(cap)) bad.push(`cap ${cap} is not a positive integer`);
  for (const o of DERBY_OUTCOMES) {
    for (const c of PROBE_CARRIES) {
      for (const b of [false, true]) {
        const p = swingPoints(o, c, b, cap);
        const at = `${o} @ ${c} barrel=${b}`;
        if (!Number.isInteger(p)) bad.push(`${at} pays ${p}, not an integer`);
        if (p > cap) bad.push(`${at} pays ${p} > cap ${cap}`);
        if (p < 0) bad.push(`${at} pays ${p} < 0`);
        // NO CONTACT, NO POINTS — at every input, including a barrelled whiff,
        // which is impossible and is probed anyway because `swingPoints` is
        // total and a future caller may not be careful.
        if ((o === 'whiff' || o === 'take') && p !== 0) bad.push(`${at} pays ${p}`);
      }
    }
  }
  return bad;
}

/**
 * The payout's FULL invariants — the cap check above plus the ordering,
 * monotonicity and barrel sweeps.
 *
 * ⚠ TEST-ONLY, AND THAT IS A DELIBERATE SPLIT rather than laziness. It walks
 * ~1,700 evaluations, and `resolveDerbyConfig` runs on every `new DerbySim` —
 * including the 40-session sweeps this game's own benches drive. More to the
 * point, everything below is a statement about CONSTANTS, which cannot change
 * between one construction and the next, so re-proving it per session is the
 * wrong place for it. `derbySim.test.ts` calls it; the runtime path calls only
 * `validatePayoutCap`, which is the half that depends on the config.
 */
export function validateDerbyPayout(cap: number): string[] {
  const bad: string[] = [...validatePayoutCap(cap)];

  // (1) THE ORDERING, SWEPT. At the same carry: home run > in play ≥ foul, and
  //     every curve is monotone in carry. Swept rather than spot-checked
  //     because the curves have different slopes and different datums.
  //
  //     ⚠ THE STRICTNESS IS CONDITIONAL ON HEADROOM, and it has to be: once the
  //     home-run curve is CLAMPED at `cap`, an in-play payout may legitimately
  //     tie it, because the clamp is a submission ceiling and not a statement
  //     about which ball was better. (It bites for real: at
  //     `pitchesPerRound = 20` the cap is 100 and both curves saturate before
  //     600 ft.) So: strict while the home run has room, never inverted after.
  for (let c = 0; c <= 700; c += 5) {
    for (const b of [false, true]) {
      const hr = swingPoints('homeRun', c, b, cap);
      const ip = swingPoints('inPlay', c, b, cap);
      const fo = swingPoints('foul', c, b, cap);
      if (ip > hr || (hr < cap && ip >= hr)) {
        bad.push(`a ${c} ft out (${ip}) pays at least as much as a ${c} ft HR (${hr})`);
      }
      // ⚠ STRICT WHENEVER THERE IS ANYTHING TO BE STRICT ABOUT. `fo > ip` alone
      // is satisfied by `FOUL_CREDIT_FRACTION = 1` — a foul paying exactly what
      // the fair ball would — which is the mutation this clause exists for. The
      // `ip > 0` guard is because both round to 0 below the contact datum.
      if (fo > ip || (ip > 0 && fo >= ip)) {
        bad.push(`a ${c} ft foul (${fo}) does not cost anything against ${c} ft in play (${ip})`);
      }
    }
    for (const o of ['homeRun', 'inPlay', 'foul'] as const) {
      if (swingPoints(o, c + 5, false, cap) < swingPoints(o, c, false, cap)) {
        bad.push(`${o} pays less at ${c + 5} ft than at ${c} ft`);
      }
    }
  }

  // (2) A BARREL IS NEVER A PENALTY, and never worth more than its own bonus.
  for (let c = 0; c <= 700; c += 25) {
    for (const o of ['homeRun', 'inPlay', 'foul'] as const) {
      const d = swingPoints(o, c, true, cap) - swingPoints(o, c, false, cap);
      if (d < 0) bad.push(`${o} @ ${c} ft: a barrel is worth ${d}`);
      if (d > BARREL_BONUS_POINTS) bad.push(`${o} @ ${c} ft: a barrel is worth ${d}, over its bonus`);
    }
  }
  return bad;
}
