// The three-free render seam between the golf economy (equipped cosmetics) and
// the GL scenes. `GolfCosmetics` is the ONLY shape the *GL.tsx scenes consume;
// they map `ball` onto the ball material and `trail?.color` onto the tracer
// line. Keeping this `three`-free means the shop / season / wallet DOM code and
// the store can import it without pulling the lazy `three` chunk.
//
// Resolution is GENERIC: the equipped catalog item's `visual` is mapped
// straight through — there is NO per-id logic. The defaults render as "no
// skin": ball_classic → undefined ball (the GL keeps its stock white ball),
// trail_none → undefined trail (no tracer recolour), frame_none → null frame.

import type { Cosmetic, EquippedCosmetics } from '../types';

// What a GL scene needs to skin the ball + tracer. All optional: an absent key
// means "use the stock look" so the default equip renders byte-identically to
// the pre-economy scenes.
export interface GolfCosmetics {
  ball?: { color?: string; metalness?: number; roughness?: number };
  trail?: { color?: string };
}

// An equipped avatar frame overlay (ring or glow), or null for frame_none.
export interface GolfFrame {
  color: string;
  style: 'ring' | 'glow';
}

function find(catalog: Cosmetic[], id: string): Cosmetic | undefined {
  return catalog.find((c) => c.id === id);
}

// Map the equipped ball + trail onto the GL seam shape. Defaults collapse to
// undefined so the scene falls back to its stock look:
//  - ball_classic (or any missing/colourless ball) → no ball override
//  - trail_none → no trail (the GL draws its default tracer / none)
export function resolveGolfCosmetics(
  catalog: Cosmetic[],
  equipped: EquippedCosmetics,
): GolfCosmetics {
  const ballItem = find(catalog, equipped.ball);
  const ballColor = ballItem?.visual.color;
  const ball =
    equipped.ball === 'ball_classic' || !ballColor
      ? undefined
      : {
          color: ballColor,
          metalness: ballItem?.visual.metalness,
          roughness: ballItem?.visual.roughness,
        };

  const trailItem = find(catalog, equipped.trail);
  const trailColor = trailItem?.visual.color;
  const trail =
    equipped.trail === 'trail_none' || !trailColor ? undefined : { color: trailColor };

  return { ball, trail };
}

// Resolve ANY frame cosmetic id → overlay descriptor, or null for
// frame_none / null / an unknown id / a colourless item. This is GENERIC (no
// per-id logic) so it resolves the equipped frame of ANY player — the viewer's
// own or another leaderboard row's — against the same shared catalog.
export function resolveFrameById(
  catalog: Cosmetic[],
  frameId: string | null | undefined,
): GolfFrame | null {
  if (!frameId || frameId === 'frame_none') return null;
  const item = find(catalog, frameId);
  const color = item?.visual.color;
  if (!color) return null;
  return { color, style: item?.visual.style === 'glow' ? 'glow' : 'ring' };
}

// The equipped frame's overlay descriptor, or null for frame_none / unknown.
export function resolveFrame(
  catalog: Cosmetic[],
  equipped: EquippedCosmetics,
): GolfFrame | null {
  return resolveFrameById(catalog, equipped.frame);
}
