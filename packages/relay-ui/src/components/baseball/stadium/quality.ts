// The stadium quality tier — a CONSERVATIVE probe, written against a named
// failure in golf.
//
// ⚠ WHY THIS IS NOT A COPY OF GOLF'S `pickWaterQuality`. That probe promotes to
// its most expensive tier on `cores > 4 && maxTextureSize >= 8192`, which a
// typical mid-range Android satisfies — so the tier meant to be gated behind GPU
// headroom is what most phones actually get. A capability sniff answers "what
// does this driver ALLOW", never "what can this GPU AFFORD".
//
// The rule here is therefore: **default DOWN, promote only on measured
// evidence.** `medium` is the default. Every automatic decision this file makes
// can only make the scene CHEAPER. `high` exists but is unreachable without an
// explicit `?quality=high` override, because there is currently no frame-time
// sample to promote on and inventing one from `hardwareConcurrency` is the exact
// mistake being avoided. When a real frame-time probe lands, it plugs in here
// and this comment says what it has to beat.
//
// ⚠ SHADOW MAP: 1024², and `high` does not raise it. GOLF.md records a 2048² map
// killing the WebView GPU process on real Android hardware while rendering fine
// in desktop software GL, and a stadium — bowl, roof, a shadow volume ~900 ft
// across — is a strictly worse case than a golf hole. Raising this needs an
// on-device test, not a passing screenshot. "Renders fine in SwiftShader" is not
// evidence of on-device safety.

import type { WebGLRenderer } from 'three';

export type StadiumTier = 'low' | 'medium' | 'high';

export interface StadiumQuality {
  tier: StadiumTier;
  /** Shadow-casting sun on/off. */
  shadows: boolean;
  /** Shadow map edge, px. NEVER above 1024 without an on-device Android test. */
  shadowMapSize: number;
  /** Angular sampling of the outfield wall, deg. A knob, never a dimension. */
  fenceStepDeg: number;
  /** Angular sampling of the seating bowl and roof ring, deg. */
  bowlStepDeg: number;
  /** Upper bound on `devicePixelRatio`. */
  pixelRatioCap: number;
  /** Why this tier was chosen — surfaced to the harness output. */
  reason: string;
}

const TIERS: Record<StadiumTier, Omit<StadiumQuality, 'reason'>> = {
  low: {
    tier: 'low',
    shadows: false,
    shadowMapSize: 1024,
    fenceStepDeg: 3,
    bowlStepDeg: 6,
    pixelRatioCap: 1,
  },
  medium: {
    tier: 'medium',
    shadows: true,
    shadowMapSize: 1024,
    fenceStepDeg: 1.5,
    bowlStepDeg: 3,
    pixelRatioCap: 1.5,
  },
  high: {
    tier: 'high',
    shadows: true,
    shadowMapSize: 1024,
    fenceStepDeg: 0.5,
    bowlStepDeg: 1.5,
    pixelRatioCap: 2,
  },
};

export const isStadiumTier = (v: unknown): v is StadiumTier =>
  v === 'low' || v === 'medium' || v === 'high';

/**
 * Choose a tier.
 *
 * `override` is the `?quality=` URL parameter, plumbed all the way through so a
 * tier can be forced on a real handset without a rebuild — which is the only way
 * to collect the on-device evidence this file refuses to guess at.
 */
export function pickStadiumQuality(
  renderer: WebGLRenderer,
  override?: string | null,
): StadiumQuality {
  if (isStadiumTier(override)) {
    return { ...TIERS[override], reason: `forced by ?quality=${override}` };
  }

  const caps = renderer.capabilities;
  const maxTex = caps.maxTextureSize ?? 0;

  // The ONLY automatic decisions, and both step DOWN. A driver reporting a small
  // texture limit or no highp fragment precision is a real, measured signal that
  // the device is weak; nothing here is allowed to read a signal as headroom.
  if (!caps.isWebGL2) {
    return { ...TIERS.low, reason: 'WebGL1 context — stepped down' };
  }
  if (maxTex < 4096) {
    return { ...TIERS.low, reason: `maxTextureSize ${maxTex} < 4096 — stepped down` };
  }
  if (caps.precision !== 'highp') {
    return { ...TIERS.low, reason: `fragment precision ${caps.precision} — stepped down` };
  }
  return { ...TIERS.medium, reason: 'default (no measured evidence to promote on)' };
}
