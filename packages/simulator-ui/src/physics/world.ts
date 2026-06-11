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

import { type RailNetwork, type SegEnd, singleRail } from './network.js';
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
  /** Which network segment the body starts on (default `main`). */
  readonly segment?: string;
  readonly color?: string;
  /** Foreign matter fouling the rail (e.g. a crate a crane dropped) rather than
   *  rolling stock — a train that strikes it at speed derails on it. Default false. */
  readonly obstacle?: boolean;
}

interface Body {
  id: string;
  kind: BodyKind;
  mode: 'railed' | 'free';
  railPos: number;
  facing: 1 | -1;
  motion: Motion;
  vel: number; // signed mm/s along +rail
  segment: string;
  maxSpeed: number;
  power: number;
  mass: number;
  halfLen: number;
  color: string | undefined;
  free: { x: number; y: number; heading: number; vx: number; vy: number };
  coupledTo: Set<string>;
  /** Why it left the rail, for the harness to assert on. */
  fate: 'on-rail' | 'derailed' | 'ran-off';
  /** Foreign matter on the rail — a train hitting it at speed derails. */
  obstacle: boolean;
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
  /** The network segment the body is on (`main` for a single rail). */
  readonly segment: string;
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
/** Rolling resistance (mm/s²) for a railed group with NO loco — a free-rolling
 *  carriage or a shed cut has no brakes, so when whatever was pushing it lets go
 *  it carries its momentum and trundles on, slowing only gently to rest. */
const ROLL_FRICTION = 320;
/** Coefficient of restitution for a head-on collision (0 = perfectly inelastic,
 *  1 = perfectly elastic). A little bounce, so the bodies recoil apart by momentum
 *  rather than freezing dead — the lighter/slower one is flung back the hardest. */
const RESTITUTION = 0.35;

export class PhysicsWorld {
  private readonly net: RailNetwork;
  private readonly bodyList: Body[] = [];
  private readonly byId = new Map<string, Body>();
  /** Live junction switch positions the network consults at transitions. */
  private readonly switches = new Map<string, string>();

  constructor(railOrNet: Rail | RailNetwork) {
    this.net = 'railOf' in railOrNet ? railOrNet : singleRail(railOrNet);
  }

  /** Throw a junction switch (a switch actuator's effect). */
  setSwitch(id: string, position: string): void {
    this.switches.set(id, position);
  }

  /** The rail a body is currently on. */
  private railOf(b: Body): Rail {
    return this.net.railOf(b.segment);
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
      segment: init.segment ?? 'main',
      maxSpeed: init.maxSpeed ?? 1200,
      power: init.power ?? (init.kind === 'loco' ? 900 : 0),
      mass: init.mass ?? (init.kind === 'loco' ? 1 : 0.6),
      halfLen: init.halfLen ?? (init.kind === 'loco' ? 34 : 30),
      color: init.color,
      free: { x: 0, y: 0, heading: 0, vx: 0, vy: 0 },
      coupledTo: new Set(),
      fate: 'on-rail',
      obstacle: init.obstacle ?? false,
    };
    this.bodyList.push(b);
    this.byId.set(b.id, b);
  }

  /** Drop a body onto the rail at the world point nearest (x,y) — the simulator
   *  side of a crane releasing a payload. Finds the closest segment + distance
   *  along it, then seeds the body there (railed). Returns its id. */
  placeBodyAt(init: Omit<BodyInit, 'railPos' | 'segment'>, x: number, y: number): string {
    let best: { seg: string; dist: number; d2: number } | null = null;
    for (const seg of this.net.segments()) {
      const rail = this.net.railOf(seg);
      const steps = Math.max(8, Math.ceil(rail.length / 10));
      for (let i = 0; i <= steps; i++) {
        const d = (rail.length * i) / steps;
        const p = rail.at(d);
        const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (best === null || d2 < best.d2) best = { seg, dist: d, d2 };
      }
    }
    const at = best ?? { seg: this.net.segments()[0] ?? 'main', dist: 0 };
    this.addBody({ ...init, segment: at.seg, railPos: at.dist });
    return init.id;
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

  /** Split a coupling between two bodies — the physical effect of the railyard
   *  crane's wedge prising the coupler faces apart (mechanical separation, not a
   *  traction contest). Symmetric; a no-op if they weren't coupled. */
  uncouple(a: string, b: string): void {
    this.byId.get(a)?.coupledTo.delete(b);
    this.byId.get(b)?.coupledTo.delete(a);
  }

  /** The ids currently coupled to `id` (for a device to read its rake makeup
   *  only by sensing/inspection, never to drive logic off ground truth). */
  coupledTo(id: string): readonly string[] {
    return [...(this.byId.get(id)?.coupledTo ?? [])];
  }

  /** Split the coupling whose midpoint is nearest world `(x, y)` within `range` —
   *  the crane wedge's positional effect (it splits whatever is under it; the
   *  controller positions it by camera, not by knowing body ids). Returns the
   *  split pair's ids, or null if no coupling is under the wedge. */
  uncoupleAt(x: number, y: number, range = 45): readonly [string, string] | null {
    let best: [string, string] | null = null;
    let bestD = range;
    for (const a of this.bodyList) {
      const pa = this.poseOf(a);
      for (const bid of a.coupledTo) {
        if (a.id >= bid) continue; // each pair once
        const b = this.byId.get(bid);
        if (b === undefined) continue;
        const pb = this.poseOf(b);
        const d = Math.hypot((pa.x + pb.x) / 2 - x, (pa.y + pb.y) / 2 - y);
        if (d <= bestD) {
          bestD = d;
          best = [a.id, bid];
        }
      }
    }
    if (best) this.uncouple(best[0], best[1]);
    return best;
  }

  /** The world position + colour of the body whose centre is nearest `(x, y)`
   *  within `radius` — what a camera at that footprint sees (sense-only). */
  sampleAt(
    x: number,
    y: number,
    radius: number,
  ): { x: number; y: number; colour: string | undefined } | null {
    let best: { x: number; y: number; colour: string | undefined } | null = null;
    let bestD = radius;
    for (const b of this.bodyList) {
      const p = this.poseOf(b);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestD) {
        bestD = d;
        best = { x: p.x, y: p.y, colour: b.color };
      }
    }
    return best;
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
        segment: b.segment,
      };
    }
    const p = this.railOf(b).at(b.railPos);
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
      segment: b.segment,
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
    const slope = this.railOf(lead).slopeAt(lead.railPos);
    const cap = Math.max(...group.map((m) => m.maxSpeed));
    const v = lead.vel;
    const hasLoco = group.some((m) => m.kind === 'loco');
    let next: number;
    if (!anyDriving && slope === 0) {
      // No traction on the level: a loco brakes itself to rest; a brakeless cut
      // (no loco) only has rolling resistance, so it coasts on, carrying momentum.
      const decel = hasLoco ? BRAKE : ROLL_FRICTION;
      next = Math.abs(v) <= decel * dtS ? 0 : v - Math.sign(v) * decel * dtS;
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
    const seg = group[0]?.segment;
    let mass = 0;
    for (const b of this.bodyList) {
      if (b.mode !== 'railed' || ids.has(b.id) || b.segment !== seg) continue;
      const gapAhead = dir > 0 ? b.railPos - b.halfLen - edge : edge - (b.railPos + b.halfLen);
      if (gapAhead >= -2 && gapAhead <= COUPLE_RANGE + 2) mass += b.mass;
    }
    return mass;
  }

  /** Derail bodies taking a curve too fast; otherwise handle each end — transition
   *  to the connected segment (a junction takes the switched branch), or buffer /
   *  run off where nothing is connected. */
  private applyRailEnds(): void {
    for (const b of this.bodyList) {
      if (b.mode !== 'railed') continue;
      const rail = this.railOf(b);
      const kappa = Math.abs(rail.curvatureAt(b.railPos));
      if (kappa > 0 && b.vel * b.vel * kappa > DERAIL_LATERAL_LIMIT) {
        this.releaseToFree(b, 'derailed');
      } else if (b.railPos > rail.length) {
        this.crossEnd(b, 'end', rail);
      } else if (b.railPos < 0) {
        this.crossEnd(b, 'start', rail);
      }
    }
  }

  /** A body past an end: follow the network to the next segment (carrying the
   *  overshoot), or, if nothing is connected, buffer (terminus) / run off (open). */
  private crossEnd(b: Body, end: SegEnd, rail: Rail): void {
    const ex = this.net.exit(b.segment, end, this.switches);
    if (ex === null) {
      const buffered = end === 'end' ? rail.endBuffered : rail.startBuffered;
      this.atEnd(b, buffered, end === 'end' ? rail.length : 0);
      return;
    }
    const overshoot = end === 'end' ? b.railPos - rail.length : -b.railPos;
    b.segment = ex.seg;
    b.railPos = ex.dir === 1 ? ex.atDist + overshoot : ex.atDist - overshoot;
    // vel + facing carry over: links are oriented so travel direction is preserved.
  }

  /** A body reaching an end with nothing connected: a buffer stops it; an open
   *  end runs it off. */
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
    const rail = this.railOf(b);
    const clamped = Math.max(0, Math.min(rail.length, b.railPos));
    const p = rail.at(clamped);
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
    // Bodies only contact within the same segment (sorted along it).
    const bySeg = new Map<string, Body[]>();
    for (const b of this.bodyList) {
      if (b.mode !== 'railed') continue;
      const arr = bySeg.get(b.segment);
      if (arr) arr.push(b);
      else bySeg.set(b.segment, [b]);
    }
    for (const arr of bySeg.values()) {
      arr.sort((a, b) => a.railPos - b.railPos);
      for (let i = 0; i < arr.length - 1; i++) {
        const lo = arr[i];
        const hi = arr[i + 1];
        if (lo !== undefined && hi !== undefined) this.resolvePair(lo, hi);
      }
    }
  }

  /** Resolve one adjacent pair (`lo` lower-railPos, `hi` higher) in contact. A
   *  body meeting another NOSE-first (driving forward into it) pushes it; meeting
   *  it TAIL-first (backing onto it) magnetically couples — regardless of whether
   *  either is a loco (couplers are on both ends of everything). Two opposed locos
   *  closing collide. */
  private resolvePair(lo: Body, hi: Body): void {
    if (lo.coupledTo.has(hi.id)) return; // already coupled: moved as a group
    const gap = hi.railPos - lo.railPos;
    const minGap = lo.halfLen + hi.halfLen;
    if (gap >= minGap + COUPLE_RANGE) return; // not touching
    if (this.tryHitObstacle(lo, hi)) return;
    if (this.tryCollide(lo, hi, minGap)) return;
    if (this.tryCouple(lo, hi, minGap)) return;
    if (gap < minGap && !this.tryPush(lo, hi, minGap)) this.separate(lo, hi, minGap);
  }

  /** A moving train meets foreign matter on the rail (a dropped crate): at speed
   *  it derails on it and scatters the debris; crept up to gently it just shoves
   *  it (falls through to the push path). Exactly one of the pair is an obstacle. */
  private tryHitObstacle(lo: Body, hi: Body): boolean {
    const obst = lo.obstacle ? lo : hi.obstacle ? hi : null;
    const train = lo.obstacle ? hi : hi.obstacle ? lo : null;
    if (obst === null || train === null || train.obstacle) return false;
    const impact = train.vel;
    if (Math.abs(impact) < 60) return false; // a crawl just nudges it — no wreck
    obst.vel = impact; // the impact flings the debris along the train's heading
    this.releaseToFree(train, 'derailed');
    this.releaseToFree(obst, 'derailed');
    // …and throws them off the rail to opposite sides, so the wreck reads as one.
    this.scatter(train, impact * 1.2);
    this.scatter(obst, -impact * 1.5);
    return true;
  }

  /** Add a lateral (perpendicular-to-heading) kick to a freed body. */
  private scatter(b: Body, lateral: number): void {
    const perp = (b.free.heading * Math.PI) / 180 + Math.PI / 2;
    b.free.vx += Math.cos(perp) * lateral;
    b.free.vy += Math.sin(perp) * lateral;
  }

  /** Two opposed locos closing → a head-on collision that CONSERVES MOMENTUM.
   *  Both halt their motors (crashed) and exchange velocities by the 1-D
   *  collision law with restitution: equal-and-opposite locos cancel to rest, but
   *  a heavier or faster one carries the pair its way and flings the lighter one
   *  back. The residual momentum then bleeds off as the wrecked locos brake. */
  private tryCollide(lo: Body, hi: Body, minGap: number): boolean {
    if (lo.kind !== 'loco' || hi.kind !== 'loco' || lo.vel - hi.vel <= 1) return false;
    const { m1, m2 } = { m1: lo.mass, m2: hi.mass };
    const v1 = lo.vel;
    const v2 = hi.vel;
    const total = m1 + m2;
    /* v1' = (m1·v1 + m2·v2 − m2·e·(v1−v2)) / (m1+m2); v2' symmetric. */
    lo.vel = (m1 * v1 + m2 * v2 - m2 * RESTITUTION * (v1 - v2)) / total;
    hi.vel = (m1 * v1 + m2 * v2 + m1 * RESTITUTION * (v1 - v2)) / total;
    lo.motion = 'stopped';
    hi.motion = 'stopped';
    this.separate(lo, hi, minGap);
    return true;
  }

  /** A body backing TAIL-first into the other (it faces away from its travel) →
   *  magnetic couple. Works loco- or carriage-led (couplers on both ends). */
  private tryCouple(lo: Body, hi: Body, minGap: number): boolean {
    const loBacksIntoHi = lo.vel > 0.1 && lo.facing === -1; // lo moves +rail, faces -rail
    const hiBacksIntoLo = hi.vel < -0.1 && hi.facing === 1; // hi moves -rail, faces +rail
    if (!loBacksIntoHi && !hiBacksIntoLo) return false;
    lo.coupledTo.add(hi.id);
    hi.coupledTo.add(lo.id);
    this.separate(lo, hi, minGap);
    return true;
  }

  /** A body driving NOSE-first into one ahead → shove it (contact, not coupled).
   *  Returns whether a shove happened. */
  private tryPush(lo: Body, hi: Body, minGap: number): boolean {
    if (lo.vel > hi.vel && lo.vel > 0 && lo.facing === 1) {
      hi.vel = lo.vel;
      hi.railPos = lo.railPos + minGap;
      return true;
    }
    if (hi.vel < lo.vel && hi.vel < 0 && hi.facing === -1) {
      lo.vel = hi.vel;
      lo.railPos = hi.railPos - minGap;
      return true;
    }
    return false;
  }

  /** Push two overlapping bodies apart to exactly `minGap`, splitting the move. */
  private separate(lo: Body, hi: Body, minGap: number): void {
    const overlap = minGap - (hi.railPos - lo.railPos);
    if (overlap <= 0) return;
    lo.railPos -= overlap / 2;
    hi.railPos += overlap / 2;
  }
}
