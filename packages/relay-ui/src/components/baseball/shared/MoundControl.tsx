import { useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { PitchCommand } from '../../../lib/baseball/ai';
import type { PitchId } from '../../../lib/baseball/pitches';
import { PITCHES } from '../../../lib/baseball/pitches';
import { AccuracyBar } from '../../golf/shared/AccuracyBar';
import { MONO_NUM, frostedSurface } from '../../golf/shared/frosted';
import {
  AIM_REACH_UV,
  ZONE_HALF_H_PX,
  ZONE_HALF_W_PX,
  aimAtPoint,
  aimMoved,
  pointOfAim,
} from './moundAim';
import type { MoundAim } from './moundAim';
import { useMoundGesture } from './prefs';

// THE MOUND: pick a pitch, place the spot, release into the sweep, tap to stop.
//
// Three inputs and they are strictly sequential — a chip, a placement, a tap —
// which is why this is ONE component and one capture surface switched by phase
// rather than two stacked ones. `ZoneReticle`'s header argues the same point for
// the batter's side: two stacked full-bleed layers is how a tap goes to the
// wrong one and the pitch the player is sure they threw never arrives.
//
// ⚠ THE CAPTURE SURFACE IS THE PANEL, NOT THE SCREEN, and that changed with the
// grammar. A slingshot has to be full-bleed because it starts wherever the
// finger lands; ABSOLUTE PLACEMENT has a rectangle, and making the rectangle the
// only live target means a stray tap somewhere else is not a wild pitch. It is
// still exactly one live layer while the mound is up, which is the rule
// `DuelGame.test.tsx`'s `layers()` counts.
//
// ⚠ AND THE PANEL IS DRAWN AT THE MAPPING'S OWN SCALE, so what the player taps
// and what the sim is told cannot disagree: 0.010 ft/px, a 141.7 × 180 px zone
// inside a 1.6-half-zone reach ellipse, every number of it from `moundAim.ts`.
// The chosen spot is MARKED — before the sweep and through it — because "the aim
// step looked like it did nothing" is half of the bug being fixed here, and a
// control whose state is invisible is a control the player cannot learn.
//
// ⚠ IT PRODUCES A `PitchCommand` AND NOTHING ELSE. The aim math is
// `moundAim.ts` (pure, and its header says why it is not golf's `pullAim`), the
// sweep is golf's `AccuracyBar` VERBATIM, and the two numbers they produce —
// an intended plate location in REPORT ft and a signed stop error in [−1, 1] —
// are the whole of the sim's pitching API. No pointer, no phase and no pixel
// reaches `lib/baseball`.
//
// ⚠ AND IT HOLDS NO GAMEPLAY STATE. The selected pitch lives in the parent (it
// is on the readout), the aim lives here until it is handed over, and the
// component is UNMOUNTED once the pitch is served — which is what resets it.
// There is no "last aim" carried between pitches, deliberately: an aim that
// persists invisibly across a half-inning is an aim nobody chose.

/** Panel size, px. DERIVED: the reach ellipse's bounding box. */
const PANEL_W = 2 * AIM_REACH_UV * ZONE_HALF_W_PX;
const PANEL_H = 2 * AIM_REACH_UV * ZONE_HALF_H_PX;

const ACCENT = '#ffd166';

export interface MoundControlProps {
  /** The pause sheet is up: the sweep freezes and taps do nothing. */
  paused?: boolean;
  /** The pitch the parent has selected. */
  pitchId: PitchId;
  onSelect: (id: PitchId) => void;
  /**
   * The intent in REPORT ft as it is placed — the HUD hands it to the renderer's
   * reticle so the player also sees it at the plate, in the scene, at the depth
   * the ball will arrive at. Quantised by `aimMoved` on the `drag` arm.
   */
  onAim: (x: number, h: number) => void;
  /** The finished command. Fired exactly once per mount. */
  onPitch: (cmd: PitchCommand) => void;
}

export function MoundControl({ paused = false, pitchId, onSelect, onAim, onPitch }: MoundControlProps) {
  // ⚠ A/B — one of the two arms is scheduled for deletion. `prefs.ts` carries the
  // removal recipe. The preference is read HERE rather than threaded from
  // `DuelGame` so that deleting it touches one component and not the screen too,
  // and so the toggle below can sit inside the duel where it is used.
  const [gesture, setGesture] = useMoundGesture();
  const [aim, setAim] = useState<MoundAim | null>(null);
  const [armed, setArmed] = useState(false);
  // The live gesture: the panel centre in client px, plus the last point fed to
  // the aim. The centre is measured ONCE per gesture — re-reading the rect on
  // every move is a forced layout, and a mid-drag reflow would teleport the mark.
  const dragRef = useRef<{ id: number; cx: number; cy: number; dx: number; dy: number } | null>(null);
  const aimRef = useRef<MoundAim | null>(null);
  const firedRef = useRef(false);

  /** Place the mark at a client point. THE one call site of `aimAtPoint`. */
  const place = (dx: number, dy: number) => {
    const next = aimAtPoint(dx, dy);
    aimRef.current = next;
    setAim(next);
    onAim(next.x, next.h);
  };

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (armed || paused) return;
    const r = e.currentTarget.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    dragRef.current = { id: e.pointerId, cx, cy, dx, dy };
    e.currentTarget.setPointerCapture(e.pointerId);
    // ⚠ BOTH ARMS PLACE ON POINTER-DOWN, AND THAT IS THE BUG FIX. The slingshot's
    // aim only existed if the finger MOVED, so a tap was a deliberate dead-centre
    // pitch. Here the first contact already carries a location, so there is no
    // gesture at all whose default is middle-middle.
    place(dx, dy);
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    // ⚠ A/B — THE ENTIRE DIFFERENCE BETWEEN THE TWO ARMS IS THIS LINE. Same
    // mapping, same command, same sweep: `tap` samples the placement once, at
    // touch-down, and a finger that slides afterwards changes nothing; `drag`
    // re-samples until the lift. Delete this test (and the toggle) to keep one.
    if (gesture !== 'drag') return;
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.cx;
    const dy = e.clientY - d.cy;
    if (!aimMoved(dx, dy, d.dx, d.dy)) return;
    d.dx = dx;
    d.dy = dy;
    place(dx, dy);
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    // A lift with no placement cannot happen — `down` always places — but the
    // sweep is still gated on a real aim rather than on a phase, because the one
    // thing this control must never do again is throw a pitch nobody aimed.
    if (!paused && aimRef.current) setArmed(true);
  };

  /** The sweep's stop → the sim's two numbers. THE mapping this file exists for. */
  const stop = (stopError: number) => {
    const a = aimRef.current;
    if (firedRef.current || !a) return;
    firedRef.current = true;
    onPitch({ id: pitchId, intentX: a.x, intentH: a.h, stopError });
  };

  const mark = aim ? pointOfAim(aim) : null;
  const line: CSSProperties = { position: 'absolute', background: 'rgba(255,255,255,0.28)' };

  return (
    <>
      {armed && <AccuracyBar paused={paused} onStop={stop} label="TAP TO RELEASE" />}

      {/* ONE bottom stack in BOTH phases. Hiding the chips while the sweep runs
          would reflow the column and slide the panel — and the mark's whole job
          is to still be exactly where the player put it while they time it. */}
      <div
        style={{
          position: 'absolute',
          zIndex: 31,
          left: 0,
          right: 0,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 22px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          pointerEvents: 'none',
        }}
      >
        <div
          data-mound-surface=""
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          style={{
            position: 'relative',
            width: PANEL_W,
            height: PANEL_H,
            borderRadius: 16,
            background: 'rgba(11,18,32,0.28)',
            touchAction: 'none',
            pointerEvents: armed || paused ? 'none' : 'auto',
            cursor: 'crosshair',
          }}
        >
          {/* The reach: an ellipse, because the clamp is radial in (u, v) and the
              two axes have different px extents. Drawn so that "you may aim off
              the plate, this far" is a thing the player can see. */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              border: '1px dashed rgba(255,255,255,0.22)',
            }}
          />
          {/* The strike zone, at the mapping's own scale. */}
          <div
            data-mound-zone=""
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 2 * ZONE_HALF_W_PX,
              height: 2 * ZONE_HALF_H_PX,
              transform: 'translate(-50%, -50%)',
              border: '2px solid rgba(255,255,255,0.6)',
              boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ ...line, left: '33.333%', top: 0, bottom: 0, width: 1 }} />
            <div style={{ ...line, left: '66.667%', top: 0, bottom: 0, width: 1 }} />
            <div style={{ ...line, top: '33.333%', left: 0, right: 0, height: 1 }} />
            <div style={{ ...line, top: '66.667%', left: 0, right: 0, height: 1 }} />
          </div>

          {/* THE MARK. Positioned by `pointOfAim`, the exact inverse of the
              mapping — never by re-deriving pixels here, which is where the drawn
              spot and the thrown spot would drift apart. */}
          {mark && (
            <div
              data-mound-mark=""
              style={{
                position: 'absolute',
                left: `calc(50% + ${mark.dxPx}px)`,
                top: `calc(50% + ${mark.dyPx}px)`,
                width: 22,
                height: 22,
                marginLeft: -11,
                marginTop: -11,
                borderRadius: '50%',
                border: `2px solid ${ACCENT}`,
                background: 'rgba(255,209,102,0.28)',
                boxShadow: '0 0 10px rgba(0,0,0,0.55)',
              }}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 340 }}>
          {PITCHES.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-label={p.name}
              onClick={() => onSelect(p.id)}
              disabled={paused || armed}
              style={{
                ...frostedSurface(999),
                ...MONO_NUM,
                pointerEvents: 'auto',
                color: p.id === pitchId ? '#0b1220' : '#fff',
                background: p.id === pitchId ? ACCENT : undefined,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: 0.6,
                padding: '7px 11px',
              }}
            >
              {p.id.toUpperCase()}
            </button>
          ))}
        </div>

        {/* ⚠ A/B — TEMPORARY. It is in the duel, not in the menu, because the
            question it settles ("which one feels better?") can only be answered
            by throwing a pitch each way, and a switch that costs a round trip
            through a menu gets used once. `prefs.ts` has the removal recipe. */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ ...MONO_NUM, fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 0.6 }}>
            AIM
          </span>
          {(['tap', 'drag'] as const).map((g) => (
            <button
              key={g}
              type="button"
              aria-label={`Aim by ${g}`}
              aria-pressed={gesture === g}
              onClick={() => setGesture(g)}
              disabled={paused || armed}
              style={{
                ...frostedSurface(999),
                ...MONO_NUM,
                pointerEvents: 'auto',
                color: gesture === g ? '#0b1220' : 'rgba(255,255,255,0.75)',
                background: gesture === g ? '#9ecbff' : undefined,
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: 0.6,
                padding: '4px 9px',
              }}
            >
              {g.toUpperCase()}
            </button>
          ))}
        </div>

        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.78)',
            textShadow: '0 1px 4px rgba(0,0,0,0.7)',
            textAlign: 'center',
            maxWidth: 300,
          }}
        >
          {armed
            ? 'Tap to release — the ring is where you asked for it.'
            : gesture === 'tap'
              ? 'Pick a pitch, then tap the spot you want it. Tap again to release.'
              : 'Pick a pitch, then press and drag the spot into place. Lift, then tap to release.'}
        </div>
      </div>
    </>
  );
}
