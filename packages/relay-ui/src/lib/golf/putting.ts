// Top-down putting mode for the Golf mini game — a GolfMode the shared
// GolfEngine drives. All simulation is in the 100x125 virtual space;
// pointer input arrives in CSS pixels and is converted through the live
// fit transform (ctx.fit()).
//
// Rendering respects the low-end-Android floor: no shadowBlur (the ball
// shadow is an offset semi-transparent ellipse) and no ctx.roundRect
// (greens use a hand-rolled rounded-rect path). Colors are read from the
// theme CSS vars each render, so a theme flip mid-round just works.

import {
  V,
  toScreen,
  toVirtual,
} from './engine';
import type { Fit, GolfMode, ModeCtx, Vec } from './engine';
import { colorMix } from './color';
import {
  BALL_R,
  CAPTURE_SPEED,
  FRICTION,
  LIP_KICK,
  MAX_LAUNCH_SPEED,
  MAX_PULL,
  MIN_PULL,
  REST_EPS,
  RESTITUTION,
} from './tuning';

export interface Wall {
  a: Vec;
  b: Vec;
}

export interface Cup {
  c: Vec;
  r: number;
}

export interface Ball {
  pos: Vec;
  vel: Vec;
  r: number;
  resting: boolean;
}

// Cosmetic rounded-rect fairway fill (virtual units).
export interface Green {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export interface Hole {
  id: number;
  par: number;
  tee: Vec;
  cup: Cup;
  walls: Wall[];
  greens: Green[];
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
  const v = (name: string, fallback: string) => {
    const raw = s.getPropertyValue(name).trim();
    return raw || fallback;
  };
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

// Hand-rolled rounded rect (no ctx.roundRect on old Android WebViews).
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export class PuttingMode implements GolfMode {
  private readonly ctxApi: ModeCtx;
  private readonly hole: Hole;
  private ball: Ball;

  // Aim state, all in CSS pixels (pointer space). `pull` = dragStart -
  // pointer; `power` is 0..1 (clamped to MAX_PULL).
  private aiming = false;
  private dragStart: Vec = { x: 0, y: 0 };
  private pull: Vec = { x: 0, y: 0 };
  private power = 0;

  constructor(ctxApi: ModeCtx, hole: Hole) {
    this.ctxApi = ctxApi;
    this.hole = hole;
    this.ball = {
      pos: { x: hole.tee.x, y: hole.tee.y },
      vel: { x: 0, y: 0 },
      r: BALL_R,
      resting: true,
    };
  }

  getState(): { resting: boolean; aiming: boolean } {
    return { resting: this.ball.resting, aiming: this.aiming };
  }

  // --- Simulation -----------------------------------------------------

  substep(h: number): void {
    const ball = this.ball;
    if (ball.resting) return;

    // Integrate.
    ball.pos = V.add(ball.pos, V.scale(ball.vel, h));

    // Exponential green friction, framerate-independent.
    const decay = Math.pow(FRICTION, h * 60);
    ball.vel = V.scale(ball.vel, decay);

    // Wall collisions: depenetrate + reflect (only when moving inward).
    for (const w of this.hole.walls) {
      const cp = V.closestPointOnSegment(ball.pos, w.a, w.b);
      const d = V.sub(ball.pos, cp);
      const dist = V.len(d);
      if (dist >= ball.r) continue;
      const n = dist > 1e-6 ? V.scale(d, 1 / dist) : { x: 0, y: -1 };
      // Push the ball back out to just touching the wall.
      ball.pos = V.add(ball.pos, V.scale(n, ball.r - dist));
      const vn = V.dot(ball.vel, n);
      if (vn < 0) {
        // Reflect the inward component with restitution.
        ball.vel = V.sub(ball.vel, V.scale(n, (1 + RESTITUTION) * vn));
      }
    }

    // Cup interaction.
    const dc = V.sub(this.hole.cup.c, ball.pos);
    const cupDist = V.len(dc);
    const speed = V.len(ball.vel);
    if (cupDist <= this.hole.cup.r) {
      if (speed <= CAPTURE_SPEED) {
        ball.pos = { x: this.hole.cup.c.x, y: this.hole.cup.c.y };
        ball.vel = { x: 0, y: 0 };
        ball.resting = true;
        this.ctxApi.emit({ type: 'sink' });
        return;
      }
      // Lip-out: an inward tug proportional to rim depth curls a
      // too-fast ball toward the hole without stopping it.
      const depth = (this.hole.cup.r - cupDist) / this.hole.cup.r;
      const toCenter = cupDist > 1e-6 ? V.scale(dc, 1 / cupDist) : { x: 0, y: 0 };
      ball.vel = V.add(ball.vel, V.scale(toCenter, LIP_KICK * depth * (h * 60)));
    }

    // Rest threshold.
    if (V.len(ball.vel) <= REST_EPS) {
      ball.vel = { x: 0, y: 0 };
      ball.resting = true;
      this.ctxApi.emit({ type: 'rest' });
    }
  }

  // --- Input ----------------------------------------------------------

  private grabRadiusPx(fit: Fit): number {
    // Generous grab area so a fingertip near the ball arms the shot.
    return Math.max(this.ball.r * fit.scale * 3, 24);
  }

  onPointerDown(p: Vec): void {
    // Armed only while the ball is at rest — no putting a moving ball.
    if (!this.ball.resting) return;
    const fit = this.ctxApi.fit();
    const ballScreen = toScreen(fit, this.ball.pos);
    if (V.len(V.sub(p, ballScreen)) > this.grabRadiusPx(fit)) return;
    this.aiming = true;
    this.dragStart = { x: p.x, y: p.y };
    this.pull = { x: 0, y: 0 };
    this.power = 0;
  }

  onPointerMove(p: Vec): void {
    if (!this.aiming) return;
    const raw = V.sub(this.dragStart, p);
    const len = V.len(raw);
    this.pull = raw;
    this.power = Math.min(len, MAX_PULL) / MAX_PULL;
  }

  onPointerUp(p: Vec): void {
    if (!this.aiming) return;
    this.aiming = false;
    const pull = V.sub(this.dragStart, p);
    const len = V.len(pull);
    // Sub-min-pull tap cancels the aim — no wasted stroke.
    if (len < MIN_PULL) {
      this.pull = { x: 0, y: 0 };
      this.power = 0;
      return;
    }
    // Direction is scale/translation-invariant, so the screen-space pull
    // direction is already the virtual-space launch direction. Only the
    // magnitude needs to map into virtual units (MAX_LAUNCH_SPEED).
    const dir = V.normalize(pull);
    const power = Math.min(len, MAX_PULL) / MAX_PULL;
    this.ball.vel = V.scale(dir, power * MAX_LAUNCH_SPEED);
    this.ball.resting = false;
    this.pull = { x: 0, y: 0 };
    this.power = 0;
    this.ctxApi.emit({ type: 'stroke' });
  }

  // --- Rendering ------------------------------------------------------

  render(ctx: CanvasRenderingContext2D, fit: Fit): void {
    const pal = readPalette();

    // Greens (cosmetic fairway fills).
    ctx.fillStyle = colorMix(pal.online, pal.card, 0.32);
    for (const g of this.hole.greens) {
      const tl = toScreen(fit, { x: g.x, y: g.y });
      roundRectPath(ctx, tl.x, tl.y, g.w * fit.scale, g.h * fit.scale, g.r * fit.scale);
      ctx.fill();
    }

    // Walls: a filled capsule-ish stroke in the separator tone.
    ctx.strokeStyle = pal.separator;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, BALL_R * fit.scale * 1.1);
    for (const w of this.hole.walls) {
      const a = toScreen(fit, w.a);
      const b = toScreen(fit, w.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Cup: a dark sunken circle.
    const cup = toScreen(fit, this.hole.cup.c);
    const cupR = this.hole.cup.r * fit.scale;
    ctx.fillStyle = colorMix(pal.text, pal.page, 0.75);
    ctx.beginPath();
    ctx.arc(cup.x, cup.y, cupR, 0, Math.PI * 2);
    ctx.fill();

    // Flag: a thin pole with an accent pennant.
    const poleH = 16 * fit.scale;
    const poleTop = { x: cup.x, y: cup.y - poleH };
    ctx.strokeStyle = pal.text;
    ctx.lineWidth = Math.max(1, 0.5 * fit.scale);
    ctx.beginPath();
    ctx.moveTo(cup.x, cup.y);
    ctx.lineTo(poleTop.x, poleTop.y);
    ctx.stroke();
    ctx.fillStyle = pal.accent;
    ctx.beginPath();
    ctx.moveTo(poleTop.x, poleTop.y);
    ctx.lineTo(poleTop.x + 9 * fit.scale, poleTop.y + 3 * fit.scale);
    ctx.lineTo(poleTop.x, poleTop.y + 6 * fit.scale);
    ctx.closePath();
    ctx.fill();

    // Ball: fake offset shadow (NO shadowBlur), then the white ball.
    const ball = toScreen(fit, this.ball.pos);
    const ballR = this.ball.r * fit.scale;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(
      ball.x + ballR * 0.35,
      ball.y + ballR * 0.5,
      ballR * 1.05,
      ballR * 0.8,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = colorMix(pal.text, pal.card, 0.25);
    ctx.lineWidth = Math.max(1, 0.3 * fit.scale);
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ballR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Aim overlay: a dashed line from the ball opposite the pull, plus a
    // power arc that goes from accent to ping as it maxes out.
    if (this.aiming && this.power > 0) {
      const dir = V.normalize(this.pull);
      const reach = 22 * fit.scale * this.power;
      const tip = { x: ball.x + dir.x * reach, y: ball.y + dir.y * reach };
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = Math.max(1.5, 0.5 * fit.scale);
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.restore();

      // Power arc around the ball.
      const arcCol = this.power >= 0.999 ? pal.ping : pal.accent;
      ctx.strokeStyle = arcCol;
      ctx.lineWidth = Math.max(2, 0.8 * fit.scale);
      ctx.beginPath();
      ctx.arc(
        ball.x,
        ball.y,
        ballR + 4 * fit.scale,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * this.power,
      );
      ctx.stroke();
    }
  }
}
