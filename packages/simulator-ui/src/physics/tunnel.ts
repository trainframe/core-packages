/**
 * Tunnels — a roofed stretch of ORDINARY track (ADR-030 sensing-only).
 *
 * A tunnel is NOT a teleport and NOT a second track graph. It is simply a
 * declaration that "this span of rail is covered" — a cosmetic roof over a
 * region of the line. The train drives the same rail straight through under it,
 * continuous and deterministic, emerging exactly where the rail leads at the
 * time its own speed dictates. `PhysicsWorld` body motion is UNAFFECTED: a tunnel
 * touches sensing only.
 *
 * Two things a tunnel can do, both OPTIONAL and per-tunnel:
 *   - OCCLUDE A CAMERA. A *dark* tunnel blinds a camera whose footprint falls
 *     under the roof — a `look` / `CameraProvider` sample of a covered point
 *     returns empty even though the body is physically there. A *lit* tunnel
 *     (instrumented with an interior light) is not occluding, so a camera over it
 *     sees fine. The default is dark.
 *   - Nothing else. MARKERS are a track-embedded tripwire (a fixed point a body
 *     crosses), entirely independent of the roof — so a hidden train is still
 *     tracked by its markers firing as it passes under the cover.
 *
 * A tunnel is described in WORLD space by the rectangular footprint of its roof
 * (the covered span × the track band). The occlusion predicate is a pure point
 * test against that rectangle, so a `CameraProvider` can consult it without any
 * knowledge of where bodies are — the camera honestly goes blind over a dark
 * tunnel, it does not peek at ground truth (ADR-031 §2).
 *
 * Pure geometry, DOM-free — unit-tested headless.
 */

/** How a tunnel treats light: a `dark` tunnel occludes a camera over it; a `lit`
 *  tunnel (interior light installed) does not. */
export type TunnelLighting = 'dark' | 'lit';

/** A roofed region of rail, declared in world space by the rectangle the roof
 *  covers. A camera footprint centre inside this rectangle is under the roof. */
export interface Tunnel {
  readonly id: string;
  /** World x of the near (entry) portal face. */
  readonly x0: number;
  /** World x of the far (exit) portal face (`x1 > x0`). */
  readonly x1: number;
  /** World y of the rail centre-line the roof straddles. */
  readonly y: number;
  /** Half-height (mm) of the covered band either side of the rail centre-line. */
  readonly halfWidth: number;
  /** `dark` (default) occludes a camera over it; `lit` does not. */
  readonly lighting: TunnelLighting;
}

export interface TunnelInit {
  readonly id: string;
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly halfWidth?: number;
  readonly lighting?: TunnelLighting;
}

/** Default half-height of a roofed band — comfortably covers a body straddling
 *  the rail so a camera over the line is fully under cover. */
const DEFAULT_HALF_WIDTH = 60;

/** Build a tunnel from its world span, defaulting to a dark roof over a band wide
 *  enough to cover the track. */
export function makeTunnel(init: TunnelInit): Tunnel {
  return {
    id: init.id,
    x0: Math.min(init.x0, init.x1),
    x1: Math.max(init.x0, init.x1),
    y: init.y,
    halfWidth: init.halfWidth ?? DEFAULT_HALF_WIDTH,
    lighting: init.lighting ?? 'dark',
  };
}

/** Whether world point `(x, y)` lies under this tunnel's roof (inside the covered
 *  rectangle). Pure geometry — no body state. */
export function coversPoint(tunnel: Tunnel, x: number, y: number): boolean {
  return (
    x >= tunnel.x0 &&
    x <= tunnel.x1 &&
    y >= tunnel.y - tunnel.halfWidth &&
    y <= tunnel.y + tunnel.halfWidth
  );
}

/**
 * A camera-occlusion predicate over a set of tunnels: `occluded(x, y)` is true
 * when `(x, y)` lies under a DARK tunnel's roof (a lit tunnel never occludes).
 * Hand this to a `CameraProvider` so a sample of a covered point returns empty —
 * the camera goes blind in the dark exactly as a real one would, without reading
 * any body ground truth.
 */
export function darkTunnelOcclusion(tunnels: readonly Tunnel[]): (x: number, y: number) => boolean {
  return (x, y) => tunnels.some((t) => t.lighting === 'dark' && coversPoint(t, x, y));
}
