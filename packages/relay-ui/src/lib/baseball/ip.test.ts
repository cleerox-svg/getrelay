// Mechanical guard on the IP boundary. BASEBALL.md promises "no MLB or club
// marks, no team nicknames, no real park or player names, no borrowed logos" —
// this test is what makes that a fact rather than a promise, which is exactly
// how BASEBALL.md describes it.
//
// The line is not "don't mention baseball". City names are fine ("Toronto"),
// colour schemes are fine (royal blue / red / white), the published *physics* of
// a baseball is fine and is the whole point of this module. What is banned is
// the trade dress: club nicknames, real park names, and the mlbstatic.com asset
// host. `packages/relay-worker/src/sports.ts` fetches those logos for the NEWS
// tab — editorial display of a live scoreboard is a different legal posture from
// shipping the same mark inside a game, and this test is the wall between them.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = 'ip.test.ts'; // necessarily contains every banned term, as patterns

// Every directory the game ships from. The scene modules land in
// components/baseball at stage 4; listing it now means the guard widens on its
// own instead of needing to be remembered.
const SCAN_DIRS = [
  HERE,
  join(HERE, '..', '..', 'components', 'baseball'),
  join(HERE, '..', '..', 'components', 'baseball', 'stadium'),
  // The HUD widgets. This is the layer that shows player-facing TEXT, so it is
  // the likeliest place for a club nickname or a real park name to arrive —
  // scanning the sim and the scene but not the strings on screen would have
  // been guarding the wrong file.
  join(HERE, '..', '..', 'components', 'baseball', 'shared'),
];

// Club nicknames. Word-boundary matched and case-insensitive, so "arrays" does
// not trip "Rays" and a lower-case identifier does not slip through either.
const NICKNAMES = [
  'yankees', 'red sox', 'blue jays', 'orioles', 'guardians', 'white sox',
  'tigers', 'twins', 'royals', 'astros', 'mariners', 'rangers', 'athletics',
  'angels', 'braves', 'mets', 'phillies', 'nationals', 'marlins', 'cubs',
  'brewers', 'reds', 'pirates', 'cardinals', 'dodgers', 'giants', 'padres',
  'rockies', 'diamondbacks',
];

// ⚠ "Rays" is the one nickname that collides with ordinary 3D vocabulary —
// `const rays = castRays(scene)` is legitimate code the stadium scene may well
// write. So it alone is matched CASE-SENSITIVELY and capitalised: a club mark
// reaching a user's eyes is capitalised in the string that renders it, while a
// raycasting local is not. This is a deliberate, documented narrowing, not an
// oversight — both halves are asserted below.
// `RAYS` too: a SCREAMING_CASE constant (`const RAYS_BLUE = …`) is the one
// spelling a case-sensitive `Rays` alone would miss, and it costs nothing.
const CASE_SENSITIVE = [/\bRays\b/, /\bRAYS\b/];

// Real park names, CURRENT AND FORMER. A venue that has been renamed does not
// stop being a mark: registrations are commonly maintained after a rename and
// residual goodwill attaches to the old name, which is why `skydome` is on this
// list rather than treated as a free legacy word.
const PARKS = [
  'fenway', 'wrigley', 'yankee stadium', 'dodger stadium', 'coors field',
  'rogers centre', 'skydome', 'camden yards', 'petco park', 'citi field',
  'busch stadium', 'minute maid', 'oracle park', 'truist park',
  'great american ball', 'pnc park', 'target field', 'comerica',
  'progressive field', 'kauffman', 'american family field', 't-mobile park',
  'globe life', 'tropicana field', 'loandepot park', 'nationals park',
  'chase field', 'angel stadium', 'citizens bank park',
];

/**
 * ⚠ THE ONE DELIBERATE EXCEPTION, AND IT IS A DECISION, NOT AN OVERSIGHT.
 *
 * OWNER DECISION, 2026-08-17. `SkyDome` is the former official name of a real
 * venue and it is what M1's home park is called. The trademark exposure was put
 * to the owner — the mark's registrations have historically been maintained and
 * residual goodwill attaches to a former official name — and the owner
 * considered it and chose to ship the name. It is their product and their risk
 * to price.
 *
 * Two things follow, and both are the reason this is written as an EXCEPTION to
 * a banned term rather than as an absent one:
 *
 *   • The name stays on `PARKS` above, so the guard's list of real venues is
 *     COMPLETE. A guard that simply did not mention `skydome` would have waved
 *     the next legacy name through in silence, and nobody would have known the
 *     question had ever been asked.
 *   • Reverting is a one-line change in `parks.ts` (`SKYDOME_NAME`) plus
 *     deleting the row below. That is the whole cost, and it is deliberately
 *     that cheap.
 *
 * An entry here must name the decision, the date and the reversal path. This is
 * an allowlist of ONE and it is not a general escape hatch: the liveness check
 * below proves each entry is actually load-bearing today, so a stale exception
 * fails the run instead of quietly widening the boundary.
 *
 * ⚠ AND THAT LAST SENTENCE WAS FALSE UNTIL THE `stringLiterals` PASS. The
 * liveness check searched the raw text of every scanned file, which the
 * constant's own IDENTIFIER, the comments explaining the decision, and two test
 * table headers each satisfied on their own — so all three of "revert
 * `SKYDOME_NAME`", "rename the identifier" and "delete the prose" left the suite
 * green, and the cheap-reversal promise was not a fact. It is now: the term must
 * appear in a STRING LITERAL of a NON-TEST source. The five probes and their
 * current verdicts are logged at the bottom of this file.
 */
const PERMITTED: Array<{ term: string; why: string }> = [
  {
    term: 'skydome',
    why: 'owner decision 2026-08-17 — M1 home park display name; revert = parks.ts SKYDOME_NAME',
  },
];

const isPermitted = (term: string) => PERMITTED.some((p) => p.term === term);

const BANNED: Array<[RegExp, string]> = [
  [/mlbstatic/i, 'borrowed logo host — editorial use in the news tab only, never in a game'],
  [/\bmlb\.com\b/i, 'league mark / asset host'],
  ...NICKNAMES.map((n) => [new RegExp(`\\b${n}\\b`, 'i'), 'club nickname'] as [RegExp, string]),
  ...CASE_SENSITIVE.map((r) => [r, 'club nickname'] as [RegExp, string]),
  ...PARKS.filter((p) => !isPermitted(p)).map(
    (p) => [new RegExp(`\\b${p}\\b`, 'i'), 'real park name'] as [RegExp, string],
  ),
];

/** Every shipping source under the baseball dirs, minus this file. */
function gameSources(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const dir of SCAN_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // components/baseball does not exist until stage 4
    }
    for (const name of entries) {
      if (name === SELF) continue;
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
      out.push({ name, text: readFileSync(join(dir, name), 'utf8') });
    }
  }
  return out;
}

/** Is this a test file? Tests SHIP NOTHING — see `assertLive`'s note. */
const isTest = (name: string) => /\.test\.tsx?$/.test(name);

/**
 * ⚠ THE STRING LITERALS OF A SOURCE FILE — comments and code stripped.
 *
 * This exists because `assertLive` was measurably NOT self-retiring, which is the
 * one property the whole exception rests on. The old check asked whether the term
 * appeared ANYWHERE in `gameSources()`, and three separate things kept it "live"
 * regardless of what the game is actually called:
 *
 *   • THE CONSTANT'S OWN IDENTIFIER. `SKYDOME_NAME` matches `/\bskydome\b/i`, so
 *     the guard was satisfied by the name of the variable holding the name. Set
 *     it to `'Harbourfront Dome'` and the permitted term was still "in use".
 *   • PROSE. `parks.ts` and `ip.test.ts` both explain the decision in comments,
 *     and a comment about a mark is not a use of one.
 *   • TEST FIXTURES. `parks.test.ts` prints `[SKYDOME FENCE …]` as a table
 *     header and `fielding.test.ts` prints `[END TO END — SkyDome …]`. Neither
 *     ships. Measured, on the shipped tree: reverting `SKYDOME_NAME`, renaming
 *     the identifier to `PARK_NAME` and deleting the comment ALL left the suite
 *     green, because those two test headers alone kept the term alive.
 *
 * A trademark exposure is text that reaches a user's eyes, and in this codebase
 * text that reaches a user's eyes is a STRING LITERAL in a non-test source. So
 * that is what is asked for, and nothing else counts.
 *
 * ⚠ IT IS A SCANNER, NOT A REGEX, AND THE ORDER IS THE WHOLE POINT. Comments
 * must be skipped BEFORE literals are collected, or `parks.ts`'s JSDoc — which
 * writes ``  `SkyDome` is the former official name  `` — reads as a template
 * literal and the prose loophole survives the fix that was meant to close it.
 * Equally, literals must be recognised while scanning so a `//` inside a URL
 * string does not swallow the rest of a line. One pass does both.
 *
 * Known limits, stated rather than discovered later: a regex literal containing
 * a quote (`/['"]/`) and raw JSX text containing an apostrophe would each
 * desync it. Neither exists anywhere under `SCAN_DIRS` today (checked), both are
 * rare in this codebase's style, and the failure mode is a FALSE POSITIVE on a
 * liveness check whose false positive is "the exception looks spent when it is
 * not" — noisy, not silent. `the literal scanner reads only literals` below
 * pins the behaviour on fixtures so a rewrite cannot quietly relax it.
 */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      let lit = '';
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          lit += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        // ⚠ A TEMPLATE'S `${…}` IS CODE, NOT TEXT — so it is skipped, not
        // accumulated. Without this, `` `${SKYDOME_NAME}` `` would put the
        // IDENTIFIER inside the "literal" and re-open the exact loophole this
        // scanner exists to close, one level down.
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        lit += src[i];
        i++;
      }
      i++;
      out.push(lit);
      continue;
    }
    i++;
  }
  return out;
}

describe('IP guard', () => {
  it('the baseball game carries no club nickname, real park name or borrowed logo host', () => {
    const files = gameSources();

    // Guard the guard: never let this become a no-op over an empty file list.
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => f.name)).toContain('airPhysics.ts');

    const violations: string[] = [];
    for (const { name, text } of files) {
      for (const [pattern, why] of BANNED) {
        text.split('\n').forEach((line, i) => {
          if (pattern.test(line)) violations.push(`${name}:${i + 1}  ${line.trim()}  — ${why}`);
        });
      }
    }
    expect(violations, `IP violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the guard actually catches the things it claims to', () => {
    // A guard nobody has watched fail is not a guard. Same discipline as the
    // gyro test next door: prove the patterns bite.
    const hits = (s: string) => BANNED.filter(([p]) => p.test(s)).length;
    expect(hits('const logo = "https://www.mlbstatic.com/team-logos/1.svg";')).toBeGreaterThan(0);
    expect(hits('name: "Blue Jays"')).toBeGreaterThan(0);
    expect(hits('park: "Rogers Centre"')).toBeGreaterThan(0);
    expect(hits('const club = { nickname: "Rays" };')).toBeGreaterThan(0);
    // ...and does NOT bite the things that are explicitly fine.
    expect(hits('const city = "Toronto"; // city name, not a club mark')).toBe(0);
    expect(hits('const arrays = new Float32Array(3);')).toBe(0);
    expect(hits('royal blue / red / white')).toBe(0);
    expect(hits('const redsAndBlues = palette();')).toBe(0);
    // The documented narrowing: raycasting vocabulary survives, the mark does not.
    expect(hits('const rays = castRays(scene);')).toBe(0);
  });

  it('the literal scanner reads only literals — not identifiers, not prose', () => {
    // ⚠ THE LIVENESS CHECK IS ONLY AS GOOD AS THIS FUNCTION, so the four ways
    // the OLD check was satisfied are pinned here as fixtures. Each line is a
    // real shape from the tree this guard scans.
    const lit = (s: string) => stringLiterals(s);
    // The identifier — the trap that made the old check unkillable. It is the
    // name of the box, not the thing in it.
    expect(lit('export const SKYDOME_NAME = getName();')).toEqual([]);
    // …and the same line WITH the name in it yields exactly the name.
    expect(lit("export const SKYDOME_NAME = 'SkyDome';")).toEqual(['SkyDome']);
    // Prose, in both comment forms, including the backticked kind `parks.ts`
    // actually writes — which a literals-first scanner would have mistaken for
    // a template literal and let the loophole survive.
    expect(lit('// `SkyDome` is the former official name of a real venue.')).toEqual([]);
    expect(lit('/**\n * `SkyDome` is the former official name.\n */\nconst a = 1;')).toEqual([]);
    expect(lit('/* park: "SkyDome" */ const a = 1;')).toEqual([]);
    // A `//` inside a string must NOT start a comment, or the rest of the line
    // (and any literal on it) vanishes.
    expect(lit('const u = "https://x/y"; const n = "SkyDome";')).toEqual([
      'https://x/y',
      'SkyDome',
    ]);
    // Escapes, and an apostrophe inside a double-quoted string.
    expect(lit('const s = "a \\" b"; const t = \'it\\\'s\';')).toEqual(['a " b', "it's"]);
    // Template literals count — a name written into one still reaches eyes —
    // but their `${…}` holes are CODE and are skipped, so an identifier cannot
    // sneak back in through an interpolation.
    expect(lit('const s = `SkyDome — ${n}`;')).toEqual(['SkyDome — ']);
    expect(lit('const s = `${SKYDOME_NAME}`;')).toEqual(['']);
    expect(lit('const s = `${a ? {b: 1} : c}x`;')).toEqual(['x']);
  });

  it('the ONE permitted park name is a live, dated, reversible decision', () => {
    // Three separate things, because each fails a different way.

    // (1) IT IS ON THE BANNED LIST. Deleting the row from `PARKS` would make the
    //     scan pass for the wrong reason — not "we decided", but "we never
    //     asked" — and the next legacy name would then slip through with it.
    for (const { term } of PERMITTED) expect(PARKS).toContain(term);

    // (2) EACH EXCEPTION IS LOAD-BEARING TODAY, AND "LOAD-BEARING" MEANS A
    //     STRING LITERAL IN A NON-TEST SOURCE. A permitted term nobody ships is
    //     a hole in the guard with no benefit, so the exception has to be spent
    //     — but the version of this line that searched the raw text of every
    //     file was satisfied by the constant's OWN IDENTIFIER, by prose, and by
    //     two test-table headers, so reverting `SKYDOME_NAME` left it green.
    //     See `stringLiterals` for the measurement and for what replaced it.
    const shipped = gameSources().filter((f) => !isTest(f.name));
    // Guard the guard, twice over: a filter that excluded everything, or a
    // scanner that returned nothing, would make (2) unfailable in the OTHER
    // direction — permanently red rather than permanently green, but equally
    // uninformative about the decision.
    expect(shipped.map((f) => f.name)).toContain('parks.ts');
    expect(shipped.map((f) => f.name)).not.toContain('parks.test.ts');
    const literals = shipped.flatMap((f) => stringLiterals(f.text));
    expect(literals.length).toBeGreaterThan(100);
    for (const { term, why } of PERMITTED) {
      const re = new RegExp(`\\b${term}\\b`, 'i');
      expect(
        literals.some((l) => re.test(l)),
        `${term} is permitted but no shipped string literal contains it — either the ` +
          `game no longer uses the name (delete the PERMITTED row) or it survives only ` +
          `in a comment, an identifier or a test fixture, none of which reach a user`,
      ).toBe(true);
      // (3) EVERY EXCEPTION CARRIES A DATE AND A REVERSAL PATH, in the row
      //     itself, so a reader of the diff sees the decision and not a word.
      expect(why, `${term}'s exception has no date`).toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
      expect(why, `${term}'s exception has no reversal path`).toMatch(/revert/i);
    }

    // (4) AND THE EXCEPTION IS EXACTLY ONE TERM WIDE. `skydome` passes; the
    //     venue's CURRENT name, which nothing here permits, still does not —
    //     that pair is the whole content of "explicit exception" and it would
    //     be vacuous if `isPermitted` matched loosely.
    const hits = (s: string) => BANNED.filter(([p]) => p.test(s)).length;
    expect(hits('export const SKYDOME_NAME = "SkyDome";')).toBe(0);
    expect(hits('name: "Rogers Centre"')).toBeGreaterThan(0);
    expect(isPermitted('skydome')).toBe(true);
    expect(isPermitted('rogers centre')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE FIVE PROBES — the exception's advertised property, MEASURED. Each was
// applied to the tree, this file run, then reverted. Counts are of failing
// tests in this file (4 total).
//
//   probe                                              before   after
//   (A) delete the PERMITTED row                       2 fail   2 fail
//   (B) add an unused term (`fenway`)                  1 fail   1 fail
//   (C) revert SKYDOME_NAME = 'Harbourfront Dome'      GREEN    1 fail
//   (D) …and rename the identifier to PARK_NAME        GREEN    1 fail
//   (E) …and strip SkyDome from the parks.ts comment   GREEN    1 fail
//
// ⚠ (C)/(D)/(E) ARE THE POINT. BASEBALL.md and this file both told the owner
// that reverting the name is one line and that the guard notices. It did not:
// `SKYDOME_NAME` matches `/\bskydome\b/i` on its own, so the constant vouched
// for its own value; and even with the identifier renamed and the prose gone,
// `parks.test.ts`'s `[SKYDOME FENCE …]` header and `fielding.test.ts`'s
// `[END TO END — SkyDome …]` header each kept the term "live" from a file that
// ships nothing. Scoping the check to string literals in non-test sources is
// what made the documented property true.
//
// ⚠ (D) IS THE ONE THAT CONSTRAINS THE FIX. A repair that merely stripped
// comments would still have passed (D) via the identifier, and one that merely
// excluded tests would still have passed (C) via the identifier. Only asking
// for the term inside a string LITERAL kills all three, which is why the
// scanner exists and why `the literal scanner reads only literals` pins it.
// ---------------------------------------------------------------------------
