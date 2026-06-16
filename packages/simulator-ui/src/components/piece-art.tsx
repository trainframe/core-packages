/**
 * Shared wooden-toy-table piece art (ADR-024 aesthetic): the wood gradients, the
 * routed rail grooves, the feature palette, and the `PieceBody` that assembles
 * them. Extracted from `ToyTable` so the same beech-wood rendering is reused by
 * any view that draws pieces — the live table AND the physics scenario view —
 * with no second copy of the palette to drift.
 *
 * Pure presentation: takes a `getPieceShape` result, draws it. No sim, no state.
 */
import type { PieceFeature, getPieceShape } from '@trainframe/simulator/track/pieces.js';

/** SVG gradient fill id defined in `WoodDefs`; referenced by url(). */
export const WOOD_FILL = 'url(#tf-wood)';

/** Render one piece feature (platform, buffer, window, lamp, boom, chevron) by
 * its semantic role. The palette lives here, with the rest of the wood theme. */
export function Feature({ feature }: { feature: PieceFeature }) {
  switch (feature.role) {
    case 'platform':
      return <path d={feature.d} fill="url(#tf-platwood)" stroke="#b08c54" strokeWidth={0.8} />;
    case 'dark-wood':
      return <path d={feature.d} fill="#6b4a2a" />;
    case 'glass':
      return (
        <path d={feature.d} fill="#bcdcea" fillOpacity={0.9} stroke="#5d7f8e" strokeWidth={0.8} />
      );
    case 'metal':
      return <path d={feature.d} fill="#aab2bc" stroke="#717a85" strokeWidth={0.6} />;
    case 'pop':
      return <path d={feature.d} fill="#ffd24a" stroke="#caa033" strokeWidth={0.6} />;
    case 'danger':
      return <path d={feature.d} fill="#d8413a" />;
    case 'line':
      return (
        <path
          d={feature.d}
          fill="none"
          stroke="#4a3216"
          strokeWidth={feature.width ?? 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

/** The two routed rail grooves: a lighter wall stroke over a deep centre
 * channel, so each groove reads as recessed into the plank. */
export function Groove({ d }: { d: string }) {
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke="#6f4c28"
        strokeWidth={2.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={d}
        fill="none"
        stroke="#3a2611"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/**
 * A piece body: a soft rim light, the wood (or device) fill, an optional
 * functional tint wash, the routed rail grooves, and any feature overlays —
 * dimmed together when the piece is an inert device.
 */
export function PieceBody({
  shape,
  bodyFill,
  tint,
  isDevice,
  dim,
}: {
  readonly shape: ReturnType<typeof getPieceShape>;
  readonly bodyFill: string;
  readonly tint: string | null;
  readonly isDevice: boolean;
  readonly dim: number;
}) {
  return (
    <g opacity={dim}>
      {/* Soft rim light for a bevelled, raised feel — drawn BEHIND the fill so the
          opaque wood covers the internal seams of multi-plank pieces (junction,
          crossing); only the outer silhouette edge shows. */}
      <path
        d={shape.svgPath}
        fill="none"
        stroke={isDevice ? '#ffffff' : '#f6e8c9'}
        strokeOpacity={isDevice ? 0.3 : 0.55}
        strokeWidth={2}
      />
      {/* Wooden plank (or device body). */}
      <path d={shape.svgPath} fill={bodyFill} />
      {/* Gentle functional colour wash over the wood (track pieces only). */}
      {!isDevice && tint !== null && <path d={shape.svgPath} fill={tint} fillOpacity={0.22} />}
      {/* Routed rail grooves, derived from the rail a train rides. */}
      {shape.grooves.map((g) => (
        <Groove key={g} d={g} />
      ))}
      {/* Detail overlays (platform, buffer, windows, lamps, boom…). */}
      {shape.features.map((f) => (
        <Feature key={f.d} feature={f} />
      ))}
    </g>
  );
}

/** Shared SVG defs (wood gradients) for any canvas that draws pieces. The
 * contact/selection shadows are CSS `filter`s, so the only defs are fills. */
export function WoodDefs() {
  return (
    <defs>
      <linearGradient id="tf-wood" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#e7c084" />
        <stop offset="0.5" stopColor="#d2a45e" />
        <stop offset="1" stopColor="#b07e3c" />
      </linearGradient>
      <linearGradient id="tf-platwood" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#eed7a8" />
        <stop offset="1" stopColor="#cda878" />
      </linearGradient>
      {/* The support pier: a darker, in-shadow wood than the deck above it, so a
        raised piece's column recedes and reads as standing under the deck. */}
      <linearGradient id="tf-pier" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#a8732f" />
        <stop offset="1" stopColor="#7a5523" />
      </linearGradient>
    </defs>
  );
}
