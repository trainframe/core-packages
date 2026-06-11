/**
 * The simulator's authoritative physical world (ADR-030).
 *
 * Bodies (locos, carriages) live on a `Rail` at a signed distance along it and
 * carry a facing, a motion intent (forward / stopped / reverse), a velocity, an
 * extent, and a traction power. The world steps them with lightweight kinematics
 * — NOT a full dynamics engine:
 *
 *   - bodies follow the rail (the rail, not the body, holds them to the curve);
 *   - contact is an extent-overlap test resolved along the rail —
 *       · two opposed locos closing  → they collide and stop each other;
 *       · a loco driving forward into a body ahead → it pushes it;
 *       · a loco reversing into a carriage → they magnetically couple;
 *   - coupled bodies move as one; a tug-of-war resolves by net traction power
 *     (equal power = stalemate);
 *   - a body taking a curve too fast (|κ|·v² over a limit) derails — the rail
 *     constraint releases and it coasts free;
 *   - a body reaching an OPEN rail end runs off into free space; a BUFFERED end
 *     (a terminus) stops it — purely here, no marker, no core.
 *
 * No device knows any of this; devices perceive its consequences through
 * sensors (the CameraProvider). DOM-free and deterministic — unit-tested headless.
 */

import type { Rail } from './rail.js';

export type Motion = 'forward' | 'stopped' | 'reverse';
export type BodyKind = 'loco' | 'carriage';

export interface BodyInit {
  readonly id: string;
  readonly kind: BodyKind;
  /** Signed distance (mm) along the rail from its start. */
  readonly railPos: number;
  /** Which way the body faces: +1 = along +rail, -1 = against. */
  readonly facing: 1 | -1;
  readonly motion?: Motion;
  /** Hard top-speed cap (mm/s). The dynamic top speed (power/(mass·DRAG)) usually
   *  governs; this only clips extreme cases. */
  readonly maxSpeed?: number;
  /** Tractive power (force). With mass it sets both acceleration (power/mass) and
   *  top speed (power/(mass·DRAG)), and decides who wins a tug-of-war. Per-loco,
   *  so different trains have different pulling capacity. Carriages are 0. */
  readonly power?: number;
  /** Mass (relative units): loco 1.0, carriage 0.6 by default. More mass → slower
   *  to accelerate and a lower top speed for the same power. */
  readonly mass?: number;
  /** Half the body's length (mm) along the rail, for contact. */
  readonly halfLen?: number;
  readonly color?: string;
}

interface Body {
  id: string;
  kind: BodyKind;
  mode: 'railed' | 'free';
  railPos: number;
  facing: 1 | -1;
  motion: Motion;
  vel: number; // signed mm/s along +rail
  maxSpeed: number;
  power: number;
  mass: number;
  halfLen: number;
  color: string | undefined;
  free: { x: number; y: number; heading: number; vx: number; vy: number };
  coupledTo: Set<string>;
  /** Why it left the rail, for the harness to assert on. */
  fate: 'on-rail' | 'derailed' | 'ran-off';
}

export interface BodyPose {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly rotationDeg: number;
  readonly kind: BodyKind;
  readonly color: string | undefined;
  readonly mode: 'railed' | 'free';
  readonly fate: 'on-rail' | 'derailed' | 'ran-off';
  readonly speed: number;
  readonly coupledTo: readonly string[];
}

/** Lateral acceleration (mm/s²) a body tolerates on a curve before it derails. */
const DERAIL_LATERAL_LIMIT = 9000;
/** Coupler capture range (mm) — a reversing loco within this of a carriage snaps on. */
const COUPLE_RANGE = 10;
/** Free-coast deceleration (mm/s²) once a body has left the rail. */
const FREE_FRICTION = 600;
/** Drag coefficient (1/s). A train's top speed settles where its tractive accel
 *  (power/mass) balances DRAG·v, so v_top = power/(mass·DRAG): more mass (more
 *  carriages) → lower top speed AND slower acceleration. A more powerful loco
 *  pulls the same load faster. */
const DRAG = 2.6;
/** Gravity along a ramp (mm/s²): subtracted going up (slower — the loco spends
 *  more of its power fighting gravity, and a weak loco can stall), added coming
 *  down (a little faster). Mass-independent (it is an acceleration). */
const RAMP_GRAVITY = 250;
/** Braking deceleration (mm/s²) when a loco is told to stop on the level. */
const BRAKE = 1100;

export class PhysicsWorld {
  private readonly rail: Rail;
  private readonly bodyList: Body[] = [];
  private readonly byId = new Map<string, Body>();

  constructor(rail: Rail) {
    this.rail = rail;
  }

  addBody(init: BodyInit): void {
    const b: Body = {
      id: init.id,
      kind: init.kind,
      mode: 'railed',
      railPos: init.railPos,
      facing: init.facing,
      motion: init.motion ?? 'stopped',
      vel: 0,
      maxSpeed: init.maxSpeed ?? 1200,
      power: init.power ?? (init.kind === 'loco' ? 900 : 0),
      mass: init.mass ?? (init.kind === 'loco' ? 1 : 0.6),
      halfLen: init.halfLen ?? (init.kind === 'loco' ? 34 : 30),
      color: init.color,
      free: { x: 0, y: 0, heading: 0, vx: 0, vy: 0 },
      coupledTo: new Set(),
      fate: 'on-rail',
    };
    this.bodyList.push(b);
    this.byId.set(b.id, b);
  }

  /** Set a body's motion intent (the only thing a loco device commands). */
  setMotion(id: string, motion: Motion): void {
    const b = this.byId.get(id);
    if (b) b.motion = motion;
  }

  /** Physically couple two bodies (e.g. to seed an already-made rake, or after a
   *  magnetic contact). Idempotent and symmetric. */
  couple(a: string, b: string): void {
    const ba = this.byId.get(a);
    const bb = this.byId.get(b);
    if (ba && bb) {
      ba.coupledTo.add(b);
      bb.coupledTo.add(a);
    }
  }

  bodies(): readonly BodyPose[] {
    return this.bodyList.map((b) => this.poseOf(b));
  }

  private poseOf(b: Body): BodyPose {
    if (b.mode === 'free') {
      return {
        id: b.id,
        x: b.free.x,
        y: b.free.y,
        rotationDeg: b.free.heading,
        kind: b.kind,
        color: b.color,
        mode: 'free',
        fate: b.fate,
        speed: Math.hypot(b.free.vx, b.free.vy),
        coupledTo: [...b.coupledTo],
      };
    }
    const p = this.rail.at(b.railPos);
    return {
      id: b.id,
      x: p.x,
      y: p.y,
      rotationDeg: (p.headingDeg + (b.facing === -1 ? 180 : 0)) % 360,
      kind: b.kind,
      color: b.color,
      mode: 'railed',
      fate: b.fate,
      speed: Math.abs(b.vel),
      coupledTo: [...b.coupledTo],
    };
  }

  /** Union-find over physical couplings → the coupled groups, one move-as-one set. */
  private groups(): Body[][] {
    const seen = new Set<string>();
    const out: Body[][] = [];
    for (const b of this.bodyList) {
      if (b.mode === 'railed' && !seen.has(b.id)) out.push(this.collectGroup(b, seen));
    }
    return out;
  }

  /** Flood-fill the coupled component containing `start`. */
  private collectGroup(start: Body, seen: Set<string>): Body[] {
    const group: Body[] = [];
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined || seen.has(cur.id)) continue;
      seen.add(cur.id);
      group.push(cur);
      for (const id of cur.coupledTo) {
        const n = this.byId.get(id);
        if (n && n.mode === 'railed' && !seen.has(id)) stack.push(n);
      }
    }
    return group;
  }

  /** The signed tractive contribution of one body (0 for carriages / stopped). */
  private tractive(b: Body): number {
    if (b.motion === 'stopped' || b.kind !== 'loco') return 0;
    const driveDir = b.facing * (b.motion === 'forward' ? 1 : -1);
    return driveDir * b.power;
  }

  step(dtS: number): void {
    this.stepFreeBodies(dtS);
    for (const group of this.groups()) this.driveGroup(group, dtS);
    this.resolveContacts();
    this.applyRailEnds();
  }

  /** Off-rail bodies coast and slow under friction. */
  private stepFreeBodies(dtS: number): void {
    for (const b of this.bodyList) {
      if (b.mode !== 'free') continue;
      const sp = Math.hypot(b.free.vx, b.free.vy);
      if (sp > 0) {
        const k = Math.max(0, sp - FREE_FRICTION * dtS) / sp;
        b.free.vx *= k;
        b.free.vy *= k;
      }
      b.free.x += b.free.vx * dtS;
      b.free.y += b.free.vy * dtS;
    }
  }

  /** Advance a coupled group as one body under Newton-ish dynamics:
   *    a = netPower/mass − DRAG·v − RAMP_GRAVITY·slope
   *  so its top speed is power/(mass·DRAG) — heavier (more carriages, or a
   *  carriage being pushed) is slower, a stronger loco is faster, and an up-slope
   *  (slope +1) saps speed while a down-slope adds it. */
  private driveGroup(group: Body[], dtS: number): void {
    const lead = group[0];
    if (lead === undefined) return;
    const netPower = group.reduce((s, m) => s + this.tractive(m), 0);
    const anyDriving = group.some((m) => m.motion !== 'stopped' && m.kind === 'loco');
    const mass = group.reduce((s, m) => s + m.mass, 0) + this.pushedMass(group, netPower);
    const slope = this.rail.slopeAt(lead.railPos);
    const cap = Math.max(...group.map((m) => m.maxSpeed));
    const v = lead.vel;
    let next: number;
    if (!anyDriving && slope === 0) {
      // Told to stop on the level: brake to rest without overshooting zero.
      next = Math.abs(v) <= BRAKE * dtS ? 0 : v - Math.sign(v) * BRAKE * dtS;
    } else {
      const a = netPower / mass - DRAG * v - RAMP_GRAVITY * slope;
      next = v + a * dtS;
    }
    if (Math.abs(next) > cap) next = Math.sign(next) * cap;
    for (const m of group) {
      m.vel = next;
      m.railPos += next * dtS;
    }
  }

  /** Mass of any body the group is shoving (in contact just ahead in its drive
   *  direction, uncoupled) — so a pushed carriage's weight slows the pusher. */
  private pushedMass(group: Body[], netPower: number): number {
    const dir = Math.sign(netPower) || Math.sign(group[0]?.vel ?? 0);
    if (dir === 0) return 0;
    const ids = new Set(group.map((m) => m.id));
    const edge =
      dir > 0
        ? Math.max(...group.map((m) => m.railPos + m.halfLen))
        : Math.min(...group.map((m) => m.railPos - m.halfLen));
    let mass = 0;
    for (const b of this.bodyList) {
      if (b.mode !== 'railed' || ids.has(b.id)) continue;
      const gapAhead = dir > 0 ? b.railPos - b.halfLen - edge : edge - (b.railPos + b.halfLen);
      if (gapAhead >= -2 && gapAhead <= COUPLE_RANGE + 2) mass += b.mass;
    }
    return mass;
  }

  /** Derail bodies taking a curve too fast; buffer or run off at the rail ends. */
  private applyRailEnds(): void {
    for (const b of this.bodyList) {
      if (b.mode !== 'railed') continue;
      const kappa = Math.abs(this.rail.curvatureAt(b.railPos));
      if (kappa > 0 && b.vel * b.vel * kappa > DERAIL_LATERAL_LIMIT) {
        this.releaseToFree(b, 'derailed');
      } else if (b.railPos > this.rail.length) {
        this.atEnd(b, this.rail.endBuffered, this.rail.length);
      } else if (b.railPos < 0) {
        this.atEnd(b, this.rail.startBuffered, 0);
      }
    }
  }

  /** A body reaching an end: a buffer stops it; an open end runs it off. */
  private atEnd(b: Body, buffered: boolean, clampTo: number): void {
    if (buffered) {
      b.railPos = clampTo;
      b.vel = 0;
      b.motion = 'stopped';
    } else {
      this.releaseToFree(b, 'ran-off');
    }
  }

  /** Move a body off the rail into free ballistic motion at its current pose. */
  private releaseToFree(b: Body, fate: 'derailed' | 'ran-off'): void {
    const clamped = Math.max(0, Math.min(this.rail.length, b.railPos));
    const p = this.rail.at(clamped);
    const headRad = (p.headingDeg * Math.PI) / 180;
    b.mode = 'free';
    b.fate = fate;
    b.free = {
      x: p.x,
      y: p.y,
      heading: (p.headingDeg + (b.facing === -1 ? 180 : 0)) % 360,
      // vel is signed along the +rail tangent, so a reversing body coasts backward.
      vx: Math.cos(headRad) * b.vel,
      vy: Math.sin(headRad) * b.vel,
    };
    // Anything coupled to it tears free of the coupling (it left the rails).
    for (const id of b.coupledTo) this.byId.get(id)?.coupledTo.delete(b.id);
    b.coupledTo.clear();
  }

  private resolveContacts(): void {
    const railed = this.bodyList
      .filter((b) => b.mode === 'railed')
      .sort((a, b) => a.railPos - b.railPos);
    for (let i = 0; i < railed.length - 1; i++) {
      const lo = railed[i];
      const hi = railed[i + 1];
      if (lo !== undefined && hi !== undefined) this.resolvePair(lo, hi);
    }
  }

  /** Resolve one adjacent pair (`lo` lower-railPos, `hi` higher) in contact:
   *  collide → couple → push, the first that applies. */
  private resolvePair(lo: Body, hi: Body): void {
    if (lo.coupledTo.has(hi.id)) return; // already coupled: moved as a group
    const gap = hi.railPos - lo.railPos;
    const minGap = lo.halfLen + hi.halfLen;
    if (gap >= minGap + COUPLE_RANGE) return; // not touching
    if (this.tryCollide(lo, hi, minGap)) return;
    if (this.tryCouple(lo, hi, minGap)) return;
    this.tryPush(lo, hi, gap, minGap);
  }

  /** Two opposed locos closing → stop both and hold them apart. */
  private tryCollide(lo: Body, hi: Body, minGap: number): boolean {
    if (lo.kind !== 'loco' || hi.kind !== 'loco' || lo.vel - hi.vel <= 1) return false;
    lo.vel = 0;
    hi.vel = 0;
    lo.motion = 'stopped';
    hi.motion = 'stopped';
    this.separate(lo, hi, minGap);
    return true;
  }

  /** A loco reversing into a carriage → magnetic couple. */
  private tryCouple(lo: Body, hi: Body, minGap: number): boolean {
    const loReversesIntoHi =
      lo.kind === 'loco' && lo.facing === -1 && lo.vel > 0 && hi.kind === 'carriage';
    const hiReversesIntoLo =
      hi.kind === 'loco' && hi.facing === 1 && hi.vel < 0 && lo.kind === 'carriage';
    if (!loReversesIntoHi && !hiReversesIntoLo) return false;
    lo.coupledTo.add(hi.id);
    hi.coupledTo.add(lo.id);
    this.separate(lo, hi, minGap);
    return true;
  }

  /** A loco driving forward into a body ahead → shove it (not coupled). */
  private tryPush(lo: Body, hi: Body, gap: number, minGap: number): void {
    if (gap >= minGap) return;
    if (lo.kind === 'loco' && lo.vel > 0 && hi.kind !== 'loco') {
      hi.vel = lo.vel;
      hi.railPos = lo.railPos + minGap;
    } else if (hi.kind === 'loco' && hi.vel < 0 && lo.kind !== 'loco') {
      lo.vel = hi.vel;
      lo.railPos = hi.railPos - minGap;
    } else {
      this.separate(lo, hi, minGap);
    }
  }

  /** Push two overlapping bodies apart to exactly `minGap`, splitting the move. */
  private separate(lo: Body, hi: Body, minGap: number): void {
    const overlap = minGap - (hi.railPos - lo.railPos);
    if (overlap <= 0) return;
    lo.railPos -= overlap / 2;
    hi.railPos += overlap / 2;
  }
}
