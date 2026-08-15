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
const SCAN_DIRS = [HERE, join(HERE, '..', '..', 'components', 'baseball')];

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
const CASE_SENSITIVE = [/\bRays\b/];

// Real park names.
const PARKS = [
  'fenway', 'wrigley', 'yankee stadium', 'dodger stadium', 'coors field',
  'rogers centre', 'camden yards', 'petco park', 'citi field', 'busch stadium',
  'minute maid', 'oracle park', 'truist park', 'great american ball',
  'pnc park', 'target field', 'comerica', 'progressive field', 'kauffman',
  'american family field', 't-mobile park', 'globe life', 'tropicana field',
  'loandepot park', 'nationals park', 'chase field', 'angel stadium',
  'citizens bank park',
];

const BANNED: Array<[RegExp, string]> = [
  [/mlbstatic/i, 'borrowed logo host — editorial use in the news tab only, never in a game'],
  [/\bmlb\.com\b/i, 'league mark / asset host'],
  ...NICKNAMES.map((n) => [new RegExp(`\\b${n}\\b`, 'i'), 'club nickname'] as [RegExp, string]),
  ...CASE_SENSITIVE.map((r) => [r, 'club nickname'] as [RegExp, string]),
  ...PARKS.map((p) => [new RegExp(`\\b${p}\\b`, 'i'), 'real park name'] as [RegExp, string]),
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
});
