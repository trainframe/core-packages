/**
 * Seedable PRNG. Uses mulberry32 — simple, fast, sufficient for simulation.
 * Not suitable for cryptography.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Avoid degenerate seeds.
    this.state = seed === 0 ? 0x12345678 : seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Random float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability p. */
  bernoulli(p: number): boolean {
    return this.next() < p;
  }

  /** Box-Muller transform for normal distribution. */
  normal(mean: number, stddev: number): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
