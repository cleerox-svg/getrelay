// Dev/CI-only preview harness for the baseball stadium scene. Mounts exactly one
// `StadiumGL` standalone — no <App>, no auth, no store — so the renderer can be
// screenshotted headlessly (`scripts/shoot-baseball.mjs`) for visual QA. It is
// never imported by the app and is not a production build input.
//
// URL query:
//   ?scene=batter|pitcher|flight|wide   camera MODE (one scene, four cameras)
//   ?park=harbourfront|alpine           which row of PARKS to build
//   ?quality=low|medium|high            forced tier — see stadium/quality.ts
//   ?exposure=<number>                  tone-mapping exposure (night games)
//
// ⚠ THE READY BEACON WAITS FOR A REAL FRAME. `window.__baseballReady` is set
// from StadiumGL's `onReady`, which fires after three rendered frames — not on
// DOMContentLoaded and not on a timer. A screenshot taken before the first
// render is a black PNG that passes every check a human is not looking at.

import { StrictMode, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import StadiumGL, { isCameraMode } from './components/baseball/StadiumGL';
import type { CameraMode, StadiumApi } from './components/baseball/StadiumGL';
import { fenceAt, HARBOURFRONT, parkById } from './lib/baseball/parks';

/**
 * The two handles the harness drives, attached by a CAST rather than by a
 * `declare global` — `src/golfpreview.tsx` already declares `window.__sim` as
 * `CourseSim | PuttSim`, and TypeScript requires merged interface declarations
 * to agree. Widening golf's declaration to accommodate ours would be editing
 * golf's file to make baseball compile, which is the wrong direction.
 */
interface PreviewWindow {
  __baseballReady?: boolean;
  /**
   * The deterministic driving surface. M1 has no `DerbySim` yet, so what is
   * exposed is the PARK — the data every later sim resolves against. When
   * `derbySim` lands it is assigned here alongside and the harness keeps working.
   */
  __sim?: {
    parkId: string;
    roofPeakFt: number;
    foulTerritoryFt: number;
    /** What `parks.ts` says the wall is at a bearing (pchip, not the knots). */
    fenceAt(bearingDeg: number): { distFt: number; heightFt: number };
  };
  __stadium?: {
    mode: CameraMode;
    stats(): ReturnType<StadiumApi['stats']>;
    /** What the BUILT GEOMETRY says the wall is at a bearing. */
    measureFence(bearingDeg: number): { distFt: number; heightFt: number } | null;
  };
}

const w = window as unknown as PreviewWindow;

const params = new URLSearchParams(location.search);
const sceneParam = params.get('scene');
const mode: CameraMode = isCameraMode(sceneParam) ? sceneParam : 'wide';
const park = parkById(params.get('park') ?? '') ?? HARBOURFRONT;
const exposureParam = Number.parseFloat(params.get('exposure') ?? '');
const exposure = Number.isFinite(exposureParam) && exposureParam > 0 ? exposureParam : 1;

w.__sim = {
  parkId: park.id,
  roofPeakFt: park.roofPeakFt,
  foulTerritoryFt: park.foulTerritoryFt,
  fenceAt: (deg) => fenceAt(park, deg),
};

function Preview() {
  // No state: the beacon is a window flag, and re-rendering the tree to record
  // it would remount the scene. Layer discipline — GL renders, nothing mirrors.
  const onReady = useCallback((api: StadiumApi) => {
    w.__stadium = {
      mode,
      stats: () => api.stats(),
      measureFence: (deg) => api.measureFence(deg),
    };
    w.__baseballReady = true;
  }, []);

  return (
    <StadiumGL
      park={park}
      mode={mode}
      exposure={exposure}
      qualityOverride={params.get('quality')}
      onReady={onReady}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
