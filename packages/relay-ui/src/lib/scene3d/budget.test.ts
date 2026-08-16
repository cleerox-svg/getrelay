// Mechanical enforcement of the `lib/scene3d` contract (see README.md).
//
// Modelled on `lib/baseball/budget.test.ts`, which exists because
// `components/golf/CourseGL.tsx` reached 2,630 lines with nothing watching it.
// AT THE CAP THE FIX IS EXTRACTION, NOT A RAISED CAP.
//
// ⚠ SCOPE. Every scan below is confined to `lib/scene3d`, `lib/golf` and
// `components/golf`. It must NEVER walk a baseball path. Baseball is built in a
// parallel session, and a repo-wide assertion here would fail THEIR build from a
// golf test the moment they add a shader or a long module — a failure they could
// not act on and would have no context for. If this kit later needs to constrain
// baseball too, that is baseball's budget test's job, not this one's.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const UI_SRC = path.resolve(__dirname, '../..');
const KIT = path.join(UI_SRC, 'lib/scene3d');

/** Shipping modules in the kit — excludes tests and docs. */
function kitModules(): string[] {
  return readdirSync(KIT)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
}

function lines(file: string): number {
  return readFileSync(file, 'utf8').split('\n').length;
}

/** Every .ts/.tsx under a dir, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('lib/scene3d — the shared kit contract', () => {
  // Contract rule 5.
  it('keeps every module under 500 lines', () => {
    const over = kitModules()
      .map((f) => [f, lines(path.join(KIT, f))] as const)
      .filter(([, n]) => n > 500);
    expect(over, `over the 500-line cap — EXTRACT, do not raise the cap: ${JSON.stringify(over)}`).toEqual([]);
  });

  // Contract rule 5. A barrel makes every consumer pay for the whole kit.
  it('has no barrel index.ts', () => {
    expect(kitModules()).not.toContain('index.ts');
  });

  // Contract rule 4. The dependency arrow runs one way: games depend on the kit.
  // The reverse would also leak the kit into lib/baseball's three-free guarantee.
  it('never imports a game module', () => {
    const offenders: string[] = [];
    for (const f of kitModules()) {
      const src = readFileSync(path.join(KIT, f), 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        if (/(^|\/)(golf|baseball)\//.test(spec)) offenders.push(`${f} → ${spec}`);
      }
    }
    expect(offenders, `lib/scene3d must not import a game: ${offenders.join(', ')}`).toEqual([]);
  });

  // Contract rule 1. A name is the cheapest signal that a module is shared; once
  // one export says `golf`, the next reader stops considering the other game.
  it('exports no game-specific name, and has no game-specific filename', () => {
    const banned = /\b(golf|course|hole|baseball|park|stadium|putt|tee|fairway|pitch|bat)\b/i;
    const offenders: string[] = [];
    for (const f of kitModules()) {
      if (banned.test(f.replace(/\.ts$/, ''))) offenders.push(`filename: ${f}`);
      const src = readFileSync(path.join(KIT, f), 'utf8');
      // Exported identifiers only — prose in comments is free to name games,
      // and the README/headers deliberately do.
      for (const m of src.matchAll(
        /^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_]+)/gm,
      )) {
        if (banned.test(m[1]!)) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders, `game-specific names in a shared kit: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('golf render path — WebGPU portability hedge', () => {
  // GRAPHICS.md §2: we stay on WebGLRenderer, but keep the GLSL surface small
  // and portable so a future TSL port is N independent file rewrites rather than
  // archaeology inside a 1,400-line module. `onBeforeCompile` is the one pattern
  // that does NOT survive the WebGPU node pipeline, so it is frozen at one site.
  //
  // A new shader belongs in its own self-contained ShaderMaterial file, not
  // injected into a standard material.
  it('uses onBeforeCompile in exactly one place, in water.ts', () => {
    const scanned = [
      ...walk(path.join(UI_SRC, 'lib/scene3d')),
      ...walk(path.join(UI_SRC, 'lib/golf')),
      ...walk(path.join(UI_SRC, 'components/golf')),
    ];
    const sites: string[] = [];
    for (const file of scanned) {
      const src = readFileSync(file, 'utf8');
      // Real call sites only — the codebase discusses this pattern in prose.
      const n = (src.match(/^[^/*\n]*\.onBeforeCompile\s*=/gm) ?? []).length;
      for (let i = 0; i < n; i++) sites.push(path.relative(UI_SRC, file));
    }
    expect(sites, `expected exactly one onBeforeCompile (lib/golf/water.ts): ${sites.join(', ')}`).toEqual([
      'lib/golf/water.ts',
    ]);
  });
});
