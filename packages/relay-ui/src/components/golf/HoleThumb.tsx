import { useId, useMemo } from 'react';
import type { CourseHole, Pt } from '../../lib/golf/terrain';
import { corridorHalfAt, greenPadRadius } from '../../lib/golf/terrain';

// A compact, pure-SVG top-down MAP of a single COURSE hole for the hole picker.
//
// IMPORTANT — this file must NOT pull three.js into the menu bundle. The golf
// menu is on the light (non-lazy) path, so HoleThumb reads ONLY the plain hole
// data + terrain.ts math (which imports no three) and draws a handful of SVG
// polygons/circles. The per-lie colours MIRROR scenery.ts's SURFACE_RGB (which
// DOES import three and so can't be imported here) so the map reads like the 3D
// scene; keep the two in sync if the scene palette changes.
//
// Projection: hole coords (d = downrange yд, x = lateral yд, +x right, tee at
// {0,0}) → a square viewBox with d up the page (tee at BOTTOM, green at TOP, so
// screen-Y is flipped) and x across (+x right). Uniform scale, letterboxed and
// centred on the hole's bounding box with a ~6% pad.

// --- Palette (MIRRORS lib/golf/scenery.ts SURFACE_RGB; 0..1 → css rgb) --------
function rgb(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}
const COL = {
  fairway: rgb([0.4, 0.66, 0.28]),
  green: rgb([0.373, 0.686, 0.337]),
  fringe: rgb([0.227, 0.431, 0.188]),
  rough: rgb([0.19, 0.37, 0.16]),
  bunker: rgb([0.9, 0.82, 0.6]),
  water: rgb([0.14, 0.42, 0.66]),
  tee: '#f4f7f0',
  pin: '#e2483d',
  flag: '#e2483d',
};

// viewBox is a fixed square in abstract units; the outer <svg> is sized in px by
// the `size` prop, so geometry is resolution-independent (memoized per hole).
const VB = 100;
const PAD = 0.06; // ~6% breathing room inside the reserved inner rect

// Fixed viewBox-space margins reserved for the SVG DECORATIONS that are drawn at
// a constant size regardless of the world scale (so they can't be included in the
// world bbox): the pin FLAG rises ~8u above the pin (+ a triangle out to +5u
// right), and the tee/pin/hazard markers have r≈2u. The projected hole is fitted
// INTO [MARGIN_X, VB−MARGIN_X] × [MARGIN_TOP, VB−MARGIN_BOTTOM] so nothing clips.
const MARGIN_TOP = 10; // flag height headroom above the highest (pin) point
const MARGIN_BOTTOM = 3; // tee/pin dot radius
const MARGIN_X = 6; // marker radius + the flag triangle's right overhang

// --- Geometry helpers (pure, viewBox units) ---------------------------------

interface Geo {
  rough: string; // polygon points
  fairway: string; // polygon points
  hazards: { kind: 'bunker' | 'water'; cx: number; cy: number; r: number }[];
  green: { cx: number; cy: number; r: number };
  fringe: { cx: number; cy: number; r: number };
  tee: { cx: number; cy: number };
  pin: { cx: number; cy: number };
}

// Per-vertex outward normal of a polyline (perpendicular to the averaged local
// tangent). Returns unit (d,x) components. Handles the 2-point straight
// centreline of a par 3 (endpoints use their single adjacent segment).
function vertexNormals(pts: Pt[]): Pt[] {
  const n = pts.length;
  const norms: Pt[] = [];
  const unit = (dd: number, dx: number): Pt => {
    const l = Math.hypot(dd, dx) || 1;
    return { d: dd / l, x: dx / l };
  };
  for (let i = 0; i < n; i++) {
    let td = 0;
    let tx = 0;
    if (i > 0) {
      const a = unit(pts[i]!.d - pts[i - 1]!.d, pts[i]!.x - pts[i - 1]!.x);
      td += a.d;
      tx += a.x;
    }
    if (i < n - 1) {
      const b = unit(pts[i + 1]!.d - pts[i]!.d, pts[i + 1]!.x - pts[i]!.x);
      td += b.d;
      tx += b.x;
    }
    const t = unit(td, tx);
    // Perpendicular to tangent (t.d, t.x): (t.x, -t.d).
    norms.push({ d: t.x, x: -t.d });
  }
  return norms;
}

// Cumulative normalized arc position [0..1] of each centreline vertex — drives
// the fairway taper (corridorHalfAt).
function arcParams(pts: Pt[]): number[] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1]!.d - pts[i]!.d, pts[i + 1]!.x - pts[i]!.x);
    seg.push(l);
    total += l;
  }
  const out = [0];
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    acc += seg[i]!;
    out.push(total > 0 ? acc / total : 0);
  }
  return out;
}

// Offset a centreline into a closed band polygon (left edge forward, right edge
// back) using a per-vertex half-width.
function bandPolygon(pts: Pt[], norms: Pt[], halfAt: (i: number) => number): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const h = halfAt(i);
    left.push({ d: pts[i]!.d + norms[i]!.d * h, x: pts[i]!.x + norms[i]!.x * h });
    right.push({ d: pts[i]!.d - norms[i]!.d * h, x: pts[i]!.x - norms[i]!.x * h });
  }
  return [...left, ...right.reverse()];
}

function buildGeo(hole: CourseHole): Geo {
  const cl = hole.centerline;
  const norms = vertexNormals(cl);
  const arc = arcParams(cl);
  const padR = greenPadRadius(hole);

  const roughPoly = bandPolygon(cl, norms, () => hole.roughHalf);
  const fairPoly = bandPolygon(cl, norms, (i) => corridorHalfAt(hole, arc[i]!));

  // Bounding box over rough corridor, green pad, hazards, tee and pin.
  let minD = Infinity;
  let maxD = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  const grow = (d: number, x: number) => {
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  };
  for (const p of roughPoly) grow(p.d, p.x);
  grow(hole.green.d - padR, hole.green.x - padR);
  grow(hole.green.d + padR, hole.green.x + padR);
  for (const hz of hole.hazards) {
    grow(hz.d - hz.r, hz.x - hz.r);
    grow(hz.d + hz.r, hz.x + hz.r);
  }
  grow(hole.tee.d, hole.tee.x);
  grow(hole.pin.d, hole.pin.x);

  const cd = (minD + maxD) / 2;
  const cx = (minX + maxX) / 2;
  const worldW = Math.max(maxX - minX, 1);
  const worldH = Math.max(maxD - minD, 1);

  // Fit the world bbox uniformly into the inner rect (VB minus the reserved
  // decoration margins), with a small extra PAD so it never touches the edges.
  const availW = VB - 2 * MARGIN_X;
  const availH = VB - MARGIN_TOP - MARGIN_BOTTOM;
  const scale = Math.min(availW / worldW, availH / worldH) * (1 - PAD);
  const innerCy = MARGIN_TOP + availH / 2;

  // Project world (d,x) → viewBox: x across (+right), d up the page (flip Y).
  // Content is centred in the inner rect, so the highest (pin) point keeps
  // MARGIN_TOP of headroom for the flag and the tee keeps MARGIN_BOTTOM below.
  const px = (x: number) => VB / 2 + (x - cx) * scale;
  const py = (d: number) => innerCy - (d - cd) * scale;
  const polyStr = (poly: Pt[]) => poly.map((p) => `${px(p.x)},${py(p.d)}`).join(' ');

  return {
    rough: polyStr(roughPoly),
    fairway: polyStr(fairPoly),
    hazards: hole.hazards.map((hz) => ({
      kind: hz.kind,
      cx: px(hz.x),
      cy: py(hz.d),
      r: hz.r * scale,
    })),
    green: { cx: px(hole.green.x), cy: py(hole.green.d), r: hole.green.r * scale },
    fringe: { cx: px(hole.green.x), cy: py(hole.green.d), r: padR * scale },
    tee: { cx: px(hole.tee.x), cy: py(hole.tee.d) },
    pin: { cx: px(hole.pin.x), cy: py(hole.pin.d) },
  };
}

interface Props {
  hole: CourseHole;
  // Rendered pixel size of the square SVG.
  size?: number;
  // Large/detailed variant draws a pin FLAG + subtle mow stripes; else a red dot.
  detail?: boolean;
  className?: string;
}

export function HoleThumb({ hole, size = 96, detail = false, className }: Props) {
  // Key on the hole OBJECT, not hole.id — ids repeat across courses (1..N) and
  // the grid stays mounted across a course switch (children keyed by h.id), so an
  // id-only key would return the previous course's geometry. CourseHole objects
  // are module-level constants, so referential identity is stable.
  const geo = useMemo(() => buildGeo(hole), [hole]);
  // Unique per instance so two mounted thumbs (armed grid + challenge sheet) can't
  // emit duplicate SVG ids and cross-clip.
  const stripeClip = `holethumb-fair-${useId()}`;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${VB} ${VB}`}
      role="img"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      {/* rough corridor (dark green) */}
      <polygon points={geo.rough} fill={COL.rough} />
      {/* fairway (mid green) */}
      <polygon points={geo.fairway} fill={COL.fairway} />
      {/* optional subtle mow stripes, clipped to the fairway */}
      {detail ? (
        <>
          <defs>
            <clipPath id={stripeClip}>
              <polygon points={geo.fairway} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${stripeClip})`}>
            {Array.from({ length: 10 }, (_, i) => (
              <rect
                key={i}
                x={0}
                y={(i * VB) / 10}
                width={VB}
                height={VB / 20}
                fill="#ffffff"
                opacity={0.05}
              />
            ))}
          </g>
        </>
      ) : null}
      {/* hazards */}
      {geo.hazards.map((hz, i) => (
        <circle
          key={i}
          cx={hz.cx}
          cy={hz.cy}
          r={hz.r}
          fill={hz.kind === 'water' ? COL.water : COL.bunker}
        />
      ))}
      {/* fringe collar ring, then the putting green */}
      <circle cx={geo.fringe.cx} cy={geo.fringe.cy} r={geo.fringe.r} fill={COL.fringe} />
      <circle cx={geo.green.cx} cy={geo.green.cy} r={geo.green.r} fill={COL.green} />
      {/* tee marker */}
      <circle cx={geo.tee.cx} cy={geo.tee.cy} r={2} fill={COL.tee} stroke="#3a4a30" strokeWidth={0.4} />
      {/* pin: flag on detail cards, else a red dot */}
      {detail ? (
        <g>
          <line
            x1={geo.pin.cx}
            y1={geo.pin.cy}
            x2={geo.pin.cx}
            y2={geo.pin.cy - 8}
            stroke="#2b2b2b"
            strokeWidth={0.8}
            strokeLinecap="round"
          />
          <polygon
            points={`${geo.pin.cx},${geo.pin.cy - 8} ${geo.pin.cx + 5},${geo.pin.cy - 6.4} ${geo.pin.cx},${geo.pin.cy - 4.8}`}
            fill={COL.flag}
          />
          <circle cx={geo.pin.cx} cy={geo.pin.cy} r={1.2} fill="#2b2b2b" />
        </g>
      ) : (
        <circle cx={geo.pin.cx} cy={geo.pin.cy} r={2} fill={COL.pin} stroke="#ffffff" strokeWidth={0.5} />
      )}
    </svg>
  );
}
