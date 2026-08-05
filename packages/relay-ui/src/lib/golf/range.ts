// Down-range 2.5D driving-range mode — a GolfMode the shared GolfEngine
// drives, sibling to the top-down PuttingMode. All simulation is in world
// space (d = downrange yards, x = lateral yards, h = height yards) and only
// projected to the engine's 100x125 virtual space at render time via
// lib/golf/projection.ts. Input is the same drag-back-to-aim/power idiom as
// putting, in CSS pixels.
//
// Rendering respects the low-end-Android floor: NO shadowBlur (the ball
// shadow is the ground projection, an offset fill), NO ctx.roundRect, and
// painter's algorithm far -> near so depth reads correctly. Colours come
// from theme CSS vars each frame (lib/golf/color.ts).

import { toScreen } from './engine';
import type { Fit, GolfMode, ModeCtx, Vec } from './engine';
import { colorMix, rgbaMix } from './color';
import { HORIZON_Y, RANGE_YD, projectGround, projectPoint, scaleAt } from './projection';
import { GRASS_END, WATER_END, surfaceAt } from './rangeTargets';
import type { Pin } from './rangeTargets';
import { CLUBS, DEFAULT_CLUB_ID, clubById } from './clubs';
import type { Club } from './clubs';
import { MAX_PULL, MIN_PULL } from './tuning';

// --- Physics constants (world space, yards & seconds) ---

// Downrange gravity. Higher than earth-real to keep flight times snappy
// (~2s for a driver) while the club ladder still carries sensibly.
const GRAVITY = 20;
// Per-substep air drag, applied as AIR_DRAG**(dt*60) — framerate-independent
// gentle bleed so towering wedges don't sail forever.
const AIR_DRAG = 0.992;
// First-bounce vertical restitution (grass/island).
const BOUNCE_RESTITUTION = 0.42;
// Below this post-bounce upward speed the ball stops hopping and rolls.
const BOUNCE_MIN = 4;
// Base roll friction per (dt*60); backspin subtracts up to BITE_K from it so
// wedges check up and the driver runs out.
const ROLL_FRICTION = 0.95;
const BITE_K = 0.16;
// Below this ground speed a rolling ball is snapped to rest.
const ROLL_REST = 2.5;
// Max lateral aim swing from the drag idiom (radians ~= 19deg each way).
const MAX_AIM_RAD = 0.33;
// Recent-positions tracer length.
const TRAIL_MAX = 26;

export type ShotResult = 'grass' | 'island' | 'water' | 'fence';

interface Ball {
  d: number;
  x: number;
  h: number;
  vd: number;
  vx: number;
  vh: number;
  inFlight: boolean;
  resting: boolean;
  grounded: boolean;
}

export interface RangeState {
  clubId: string;
  clubName: string;
  windAlong: number;
  windCross: number;
  inFlight: boolean;
  resting: boolean;
  aiming: boolean;
  power: number;
  aimDeg: number;
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  longestDrive: number;
  lastResult: ShotResult | null;
  nearestPin: number | null;
  onTarget: boolean;
  hasTarget: boolean;
}

export interface RangeOptions {
  initialClubId?: string;
  windAlong?: number;
  windCross?: number;
  // Pins to render. Defaults handled by the caller (usually PINS).
  pins: Pin[];
  // Challenge target; when set, nearest-pin distance & on-target are scored
  // against it and it is highlighted in the render.
  target?: Pin | null;
}

interface Palette {
  accent: string;
  text: string;
  card: string;
  separator: string;
  page: string;
  online: string;
  ping: string;
}

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--accent', '#3b82f6'),
    text: v('--text', '#111111'),
    card: v('--card-bg', '#ffffff'),
    separator: v('--separator', '#d0d0d0'),
    page: v('--page-bg', '#f2f2f2'),
    online: v('--online', '#22c55e'),
    ping: v('--ping', '#ef4444'),
  };
}

export class RangeMode implements GolfMode {
  private readonly ctxApi: ModeCtx;
  private readonly pins: Pin[];
  private target: Pin | null;
  private clubId: string;
  private windAlong: number;
  private windCross: number;

  private ball: Ball;
  private trail: { d: number; x: number; h: number }[] = [];

  // Per-shot readouts.
  private carry = 0;
  private total = 0;
  private apex = 0;
  private ballSpeed = 0;
  private longestDrive = 0;
  private lastResult: ShotResult | null = null;
  private firstLanding = true;
  private rollDecay = ROLL_FRICTION;

  // Aim state (CSS pixels), mirroring PuttingMode.
  private aiming = false;
  private dragStart: Vec = { x: 0, y: 0 };
  private pull: Vec = { x: 0, y: 0 };
  private power = 0;

  constructor(ctxApi: ModeCtx, opts: RangeOptions) {
    this.ctxApi = ctxApi;
    this.pins = opts.pins;
    this.target = opts.target ?? null;
    this.clubId = opts.initialClubId ?? DEFAULT_CLUB_ID;
    this.windAlong = opts.windAlong ?? 0;
    this.windCross = opts.windCross ?? 0;
    this.ball = this.teedBall();
  }

  private teedBall(): Ball {
    return {
      d: 0,
      x: 0,
      h: 0,
      vd: 0,
      vx: 0,
      vh: 0,
      inFlight: false,
      resting: true,
      grounded: false,
    };
  }

  private club(): Club {
    return clubById(this.clubId);
  }

  // --- Public control surface (used by RangeGame via the canvas handle) --

  selectClub(id: string): void {
    if (this.ball.inFlight) return;
    if (CLUBS.some((c) => c.id === id)) this.clubId = id;
  }

  cycleClub(dir: 1 | -1): void {
    if (this.ball.inFlight) return;
    const i = CLUBS.findIndex((c) => c.id === this.clubId);
    const n = (i + dir + CLUBS.length) % CLUBS.length;
    this.clubId = CLUBS[n]!.id;
  }

  setWind(along: number, cross: number): void {
    this.windAlong = along;
    this.windCross = cross;
  }

  // Point the challenge at a new pin. Does NOT move the ball: the just-
  // landed ball stays put so the player sees the result; the next drag
  // (onPointerDown) re-tees it.
  setTarget(pin: Pin | null): void {
    this.target = pin;
  }

  // Return the ball to the tee, ready to aim. Keeps the last shot's
  // readouts visible until the next swing clears them.
  teeUp(): void {
    this.ball = this.teedBall();
    this.trail = [];
    this.aiming = false;
    this.pull = { x: 0, y: 0 };
    this.power = 0;
  }

  getState(): RangeState {
    const club = this.club();
    return {
      clubId: this.clubId,
      clubName: club.name,
      windAlong: this.windAlong,
      windCross: this.windCross,
      inFlight: this.ball.inFlight,
      resting: this.ball.resting,
      aiming: this.aiming,
      power: this.power,
      aimDeg: (this.aimAngle() * 180) / Math.PI,
      carry: Math.round(this.carry),
      total: Math.round(this.total),
      apex: Math.round(this.apex),
      ballSpeed: Math.round(this.ballSpeed),
      longestDrive: Math.round(this.longestDrive),
      lastResult: this.lastResult,
      nearestPin: this.nearestPinDist(),
      onTarget: this.isOnTarget(),
      hasTarget: this.target != null,
    };
  }

  // --- Simulation --------------------------------------------------------

  substep(dt: number): void {
    const b = this.ball;
    if (!b.inFlight) return;

    // Wind pushes as a steady acceleration on both ground and air paths.
    b.vd += this.windAlong * dt;
    b.vx += this.windCross * dt;

    if (b.grounded) {
      const decay = Math.pow(this.rollDecay, dt * 60);
      b.vd *= decay;
      b.vx *= decay;
      b.d += b.vd * dt;
      b.x += b.vx * dt;
      this.total = b.d;
      const surf = surfaceAt(b.d, b.x);
      if (surf === 'water') return this.stop('water');
      if (surf === 'fence' || b.d >= RANGE_YD) return this.stop('fence');
      if (Math.hypot(b.vd, b.vx) <= ROLL_REST) return this.stop('rest');
      this.pushTrail();
      return;
    }

    // Airborne: gravity + drag, then integrate.
    b.vh -= GRAVITY * dt;
    const drag = Math.pow(AIR_DRAG, dt * 60);
    b.vd *= drag;
    b.vx *= drag;
    b.vh *= drag;
    b.d += b.vd * dt;
    b.x += b.vx * dt;
    b.h += b.vh * dt;
    if (b.h > this.apex) this.apex = b.h;
    this.pushTrail();

    if (b.h <= 0 && b.vh < 0) {
      b.h = 0;
      if (this.firstLanding) {
        this.carry = b.d;
        this.firstLanding = false;
        this.ctxApi.emit({ type: 'land' });
      }
      const surf = surfaceAt(b.d, b.x);
      if (surf === 'fence' || b.d >= RANGE_YD) return this.stop('fence');
      if (surf === 'water') return this.stop('water');
      // Grass / island: bounce, or settle into a roll if the hop is spent.
      const club = this.club();
      const up = -b.vh * BOUNCE_RESTITUTION;
      if (up < BOUNCE_MIN) {
        b.grounded = true;
        b.vh = 0;
        b.vd *= club.rollFactor;
        b.vx *= club.rollFactor;
        this.rollDecay = Math.max(0.6, ROLL_FRICTION - club.backspin * BITE_K);
      } else {
        b.vh = up;
        const keep = 0.55 + 0.4 * club.rollFactor;
        b.vd *= keep;
        b.vx *= keep;
      }
    }
  }

  private stop(kind: 'rest' | 'water' | 'fence'): void {
    const b = this.ball;
    b.inFlight = false;
    b.resting = true;
    b.grounded = false;
    b.vd = b.vx = b.vh = 0;
    b.h = 0;
    this.total = b.d;
    if (kind === 'water') {
      this.lastResult = 'water';
      this.ctxApi.emit({ type: 'splash' });
    } else if (kind === 'fence') {
      this.lastResult = 'fence';
      this.ctxApi.emit({ type: 'fence' });
    } else {
      this.lastResult = surfaceAt(b.d, b.x) === 'island' ? 'island' : 'grass';
      this.ctxApi.emit({ type: 'rest' });
    }
    this.longestDrive = Math.max(this.longestDrive, b.d);
  }

  private pushTrail(): void {
    const b = this.ball;
    this.trail.push({ d: b.d, x: b.x, h: b.h });
    if (this.trail.length > TRAIL_MAX) this.trail.shift();
  }

  private nearestPinDist(): number | null {
    const b = this.ball;
    if (b.inFlight) return null;
    if (this.lastResult == null) return null;
    if (this.target) {
      return Math.round(Math.hypot(b.d - this.target.d, b.x - this.target.x));
    }
    let best = Infinity;
    for (const p of this.pins) best = Math.min(best, Math.hypot(b.d - p.d, b.x - p.x));
    return Number.isFinite(best) ? Math.round(best) : null;
  }

  private isOnTarget(): boolean {
    if (!this.target || this.lastResult == null) return false;
    if (this.lastResult === 'water' || this.lastResult === 'fence') return false;
    const b = this.ball;
    return Math.hypot(b.d - this.target.d, b.x - this.target.x) <= this.target.r;
  }

  // --- Input (drag back to aim/power, in CSS pixels) ---------------------

  private aimAngle(): number {
    const t = Math.max(-1, Math.min(1, this.pull.x / MAX_PULL));
    return t * MAX_AIM_RAD;
  }

  onPointerDown(p: Vec): void {
    if (this.ball.inFlight) return;
    // Re-tee for the next shot the moment the player starts a new drag, so
    // the ball always launches from the tee and the aim reference is fixed.
    this.teeUp();
    this.aiming = true;
    this.dragStart = { x: p.x, y: p.y };
    this.pull = { x: 0, y: 0 };
    this.power = 0;
  }

  onPointerMove(p: Vec): void {
    if (!this.aiming) return;
    const raw = { x: this.dragStart.x - p.x, y: this.dragStart.y - p.y };
    this.pull = raw;
    this.power = Math.min(Math.hypot(raw.x, raw.y), MAX_PULL) / MAX_PULL;
  }

  onPointerUp(p: Vec): void {
    if (!this.aiming) return;
    this.aiming = false;
    const pull = { x: this.dragStart.x - p.x, y: this.dragStart.y - p.y };
    const len = Math.hypot(pull.x, pull.y);
    if (len < MIN_PULL) {
      this.pull = { x: 0, y: 0 };
      this.power = 0;
      return;
    }
    this.pull = pull;
    this.power = Math.min(len, MAX_PULL) / MAX_PULL;
    this.swing();
  }

  private swing(): void {
    const club = this.club();
    const b = this.ball;
    const s = club.baseSpeed * this.power;
    const loft = (club.loft * Math.PI) / 180;
    const aim = this.aimAngle();
    const sH = s * Math.cos(loft);
    b.d = 0;
    b.x = 0;
    b.h = 0;
    b.vh = s * Math.sin(loft);
    b.vd = sH * Math.cos(aim);
    b.vx = sH * Math.sin(aim);
    b.inFlight = true;
    b.resting = false;
    b.grounded = false;
    // Reset per-shot readouts.
    this.ballSpeed = s;
    this.carry = 0;
    this.total = 0;
    this.apex = 0;
    this.firstLanding = true;
    this.lastResult = null;
    this.trail = [];
    this.aiming = false;
    this.power = 0;
    this.pull = { x: 0, y: 0 };
    this.ctxApi.emit({ type: 'launch' });
  }

  // --- Rendering (painter's algorithm, far -> near) ----------------------

  render(ctx: CanvasRenderingContext2D, fit: Fit): void {
    const pal = readPalette();
    const now = performance.now() / 1000;

    // Project a world point (raised by height h) to CSS pixels.
    const P = (d: number, x: number, h: number): Vec => {
      const pr = projectPoint(d, x, h);
      return toScreen(fit, { x: pr.sx, y: pr.sy });
    };
    const Pg = (d: number, x: number): Vec => {
      const pr = projectGround(d, x);
      return toScreen(fit, { x: pr.sx, y: pr.sy });
    };

    this.drawSky(ctx, fit, pal);
    this.drawWater(ctx, fit, pal, now, Pg);
    this.drawFence(ctx, fit, pal, Pg);
    this.drawIslandsAndGrassPins(ctx, fit, pal, Pg);
    this.drawGrass(ctx, fit, pal, Pg);
    this.drawYardageMarkers(ctx, fit, pal, Pg);
    this.drawTracer(ctx, pal, P);
    this.drawBall(ctx, fit, pal, P, Pg);
    this.drawAim(ctx, fit, pal);
  }

  private drawSky(ctx: CanvasRenderingContext2D, fit: Fit, pal: Palette): void {
    const top = toScreen(fit, { x: 0, y: 0 });
    const horizon = toScreen(fit, { x: 0, y: HORIZON_Y });
    const w = 100 * fit.scale;
    const g = ctx.createLinearGradient(0, top.y, 0, horizon.y);
    g.addColorStop(0, colorMix(pal.accent, pal.card, 0.78));
    g.addColorStop(1, colorMix(pal.card, pal.accent, 0.12));
    ctx.fillStyle = g;
    ctx.fillRect(top.x, top.y, w, horizon.y - top.y);
  }

  private drawWater(
    ctx: CanvasRenderingContext2D,
    fit: Fit,
    pal: Palette,
    now: number,
    Pg: (d: number, x: number) => Vec,
  ): void {
    // Water is a trapezoid between the grass edge (near) and the back lip
    // (far). Build it from the projected left/right edges at both depths.
    const nearL = Pg(GRASS_END, -60);
    const nearR = Pg(GRASS_END, 60);
    const farL = Pg(WATER_END, -60);
    const farR = Pg(WATER_END, 60);
    const g = ctx.createLinearGradient(0, farL.y, 0, nearL.y);
    const blue = colorMix('#1b6fb0', pal.accent, 0.35);
    g.addColorStop(0, colorMix(blue, pal.card, 0.35));
    g.addColorStop(1, colorMix(blue, '#0a3d66', 0.25));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(farL.x, farL.y);
    ctx.lineTo(farR.x, farR.y);
    ctx.lineTo(nearR.x, nearR.y);
    ctx.lineTo(nearL.x, nearL.y);
    ctx.closePath();
    ctx.fill();

    // Cheap animated reflection: a few horizontal shimmer bands whose x
    // wobbles with time. No shadowBlur — just translucent strokes.
    ctx.save();
    ctx.clip();
    ctx.lineWidth = Math.max(1, 0.6 * fit.scale);
    for (let i = 0; i < 5; i++) {
      const d = GRASS_END + ((WATER_END - GRASS_END) * (i + 0.5)) / 5;
      const wob = Math.sin(now * 1.3 + i) * 6;
      const a = Pg(d, -50 + wob);
      const b = Pg(d, 50 + wob);
      ctx.strokeStyle = `rgba(255,255,255,${0.05 + 0.05 * Math.abs(Math.sin(now + i))})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawFence(
    ctx: CanvasRenderingContext2D,
    fit: Fit,
    pal: Palette,
    Pg: (d: number, x: number) => Vec,
  ): void {
    // Boundary fence at the very back (d ~ RANGE_YD): a row of short posts
    // with a rail, sitting on the far grass lip.
    const scale = scaleAt(RANGE_YD);
    const postH = 10 * scale;
    const baseL = Pg(RANGE_YD - 2, -55);
    const baseR = Pg(RANGE_YD - 2, 55);
    ctx.strokeStyle = colorMix(pal.text, pal.card, 0.35);
    ctx.lineWidth = Math.max(1, 1.2 * scale * fit.scale);
    // Top rail.
    ctx.beginPath();
    ctx.moveTo(baseL.x, baseL.y - postH * fit.scale);
    ctx.lineTo(baseR.x, baseR.y - postH * fit.scale);
    ctx.stroke();
    // Posts.
    for (let i = 0; i <= 10; i++) {
      const x = -55 + (110 * i) / 10;
      const p = Pg(RANGE_YD - 2, x);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y - postH * fit.scale);
      ctx.stroke();
    }
  }

  private drawIslandsAndGrassPins(
    ctx: CanvasRenderingContext2D,
    fit: Fit,
    pal: Palette,
    Pg: (d: number, x: number) => Vec,
  ): void {
    // Far -> near so nearer islands overlap farther ones correctly.
    const pins = [...this.pins].sort((a, b) => b.d - a.d);
    for (const pin of pins) {
      const c = Pg(pin.d, pin.x);
      const pr = scaleAt(pin.d);
      const rx = pin.r * 1.35 * pr * fit.scale;
      const ry = rx * 0.5;
      const isTarget = this.target?.id === pin.id;

      if (pin.kind !== 'grass') {
        // Grass patch / island ellipse floating on the water.
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.beginPath();
        ctx.ellipse(c.x, c.y + ry * 0.35, rx * 1.05, ry * 1.05, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colorMix(pal.online, '#2f7d3a', 0.35);
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = colorMix(pal.online, pal.card, 0.25);
        ctx.beginPath();
        ctx.ellipse(c.x, c.y - ry * 0.2, rx * 0.7, ry * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      this.drawFlag(ctx, fit, pal, c, pr, isTarget);
    }
  }

  private drawFlag(
    ctx: CanvasRenderingContext2D,
    fit: Fit,
    pal: Palette,
    base: Vec,
    pr: number,
    highlight: boolean,
  ): void {
    const poleH = 14 * pr * fit.scale;
    const top = { x: base.x, y: base.y - poleH };
    ctx.strokeStyle = pal.text;
    ctx.lineWidth = Math.max(1, 0.4 * pr * fit.scale);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();
    const fw = 8 * pr * fit.scale;
    const fh = 5 * pr * fit.scale;
    ctx.fillStyle = highlight ? pal.ping : pal.accent;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(top.x + fw, top.y + fh * 0.5);
    ctx.lineTo(top.x, top.y + fh);
    ctx.closePath();
    ctx.fill();
    if (highlight) {
      // Target ring on the ground so the challenge pin pops.
      ctx.strokeStyle = pal.ping;
      ctx.lineWidth = Math.max(1, 0.5 * pr * fit.scale);
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, fw * 1.4, fw * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawGrass(
    ctx: CanvasRenderingContext2D,
    fit: Fit,
    pal: Palette,
    Pg: (d: number, x: number) => Vec,
  ): void {
    // Near grass 0..GRASS_END: a trapezoid from the tee line to the water
    // edge, plus a tee marker.
    const nearL = Pg(0, -60);
    const nearR = Pg(0, 60);
    const farL = Pg(GRASS_END, -60);
    const farR = Pg(GRASS_END, 60);
    const g = ctx.createLinearGradient(0, farL.y, 0, nearL.y);
    g.addColorStop(0, colorMix(pal.online, '#2f7d3a', 0.3));
    g.addColorStop(1, colorMix(pal.online, pal.card, 0.28));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(farL.x, farL.y);
    ctx.lineTo(farR.x, farR.y);
    ctx.lineTo(nearR.x, nearR.y);
    ctx.lineTo(nearL.x, nearL.y);
    ctx.closePath();
    ctx.fill();

    // Tee patch: a small darker mat at d=0.
    const t = Pg(0, 0);
    ctx.fillStyle = colorMix(pal.online, pal.text, 0.22);
    ctx.beginPath();
    ctx.ellipse(t.x, t.y, 7 * fit.scale, 3 * fit.scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawYardageMarkers(
    ctx: CanvasRenderingContext2D,
    fit: Fit,
    pal: Palette,
    Pg: (d: number, x: number) => Vec,
  ): void {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const yd of [100, 150, 200, 250, 300]) {
      const pr = scaleAt(yd);
      const a = Pg(yd, -55);
      const b = Pg(yd, 55);
      ctx.strokeStyle = `rgba(255,255,255,${0.16 * pr + 0.05})`;
      ctx.lineWidth = Math.max(0.5, 0.4 * pr * fit.scale);
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const fontPx = Math.max(7, 4.2 * pr * fit.scale);
      ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
      ctx.fillStyle = colorMix(pal.text, pal.card, 0.35);
      ctx.fillText(`${yd}`, b.x - 2, b.y - fontPx * 0.7);
    }
  }

  private drawTracer(
    ctx: CanvasRenderingContext2D,
    pal: Palette,
    P: (d: number, x: number, h: number) => Vec,
  ): void {
    if (this.trail.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const n = this.trail.length;
    for (let i = 1; i < n; i++) {
      const a = this.trail[i - 1]!;
      const b = this.trail[i]!;
      const pa = P(a.d, a.x, a.h);
      const pb = P(b.d, b.x, b.h);
      const alpha = (i / n) * 0.7;
      ctx.strokeStyle = rgbaMix(pal.ping, pal.accent, i / n, alpha);
      ctx.lineWidth = 1 + (i / n) * 2;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }

  private drawBall(
    ctx: CanvasRenderingContext2D,
    fit: Fit,
    pal: Palette,
    P: (d: number, x: number, h: number) => Vec,
    Pg: (d: number, x: number) => Vec,
  ): void {
    const b = this.ball;
    const pr = scaleAt(b.d);
    const rBall = Math.max(1.5, 2.2 * pr * fit.scale);

    // Ground shadow = the h=0 projection. The gap up to the ball sells lift.
    const sh = Pg(b.d, b.x);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y, rBall * 1.1, rBall * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    const p = P(b.d, b.x, b.h);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = colorMix(pal.text, pal.card, 0.25);
    ctx.lineWidth = Math.max(1, 0.3 * fit.scale);
    ctx.beginPath();
    ctx.arc(p.x, p.y, rBall, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawAim(ctx: CanvasRenderingContext2D, fit: Fit, pal: Palette): void {
    if (!this.aiming || this.power <= 0) return;
    const b = this.ball;
    const base = toScreen(fit, {
      x: projectGround(b.d, b.x).sx,
      y: projectGround(b.d, b.x).sy,
    });
    // Aim arrow points downrange (up-screen), fanned by the lateral aim.
    const aim = this.aimAngle();
    const reach = (18 + 40 * this.power) * fit.scale;
    const tip = {
      x: base.x + Math.sin(aim) * reach,
      y: base.y - Math.cos(aim) * reach,
    };
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = Math.max(1.5, 0.5 * fit.scale);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.restore();

    // Power meter: a bar climbing from accent to ping as it maxes.
    const barW = 40 * fit.scale;
    const barH = 5 * fit.scale;
    const bx = base.x - barW / 2;
    const by = base.y + 10 * fit.scale;
    ctx.fillStyle = colorMix(pal.card, pal.text, 0.15);
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = this.power >= 0.999 ? pal.ping : pal.accent;
    ctx.fillRect(bx, by, barW * this.power, barH);
    ctx.strokeStyle = pal.separator;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, barW, barH);
  }
}
