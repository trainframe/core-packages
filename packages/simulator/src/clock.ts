/**
 * Virtual clock with scheduled callbacks. The simulator advances time
 * explicitly; nothing happens between calls to `advance()`.
 *
 * Callbacks scheduled at the same instant fire in insertion order.
 */
export class VirtualClock {
  private now_ms = 0;
  private nextId = 0;
  private timers: Array<{ id: number; fire_at_ms: number; cb: () => void }> = [];

  now(): number {
    return this.now_ms;
  }

  schedule(in_ms: number, cb: () => void): number {
    const id = this.nextId++;
    this.timers.push({ id, fire_at_ms: this.now_ms + in_ms, cb });
    this.timers.sort((a, b) => a.fire_at_ms - b.fire_at_ms || a.id - b.id);
    return id;
  }

  cancel(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  /**
   * Advance the clock by ms, firing all callbacks scheduled within. New
   * callbacks scheduled by fired callbacks are also processed if they
   * fall within the advance window.
   */
  advance(ms: number): void {
    const target = this.now_ms + ms;
    while (this.timers.length > 0) {
      const next = this.timers[0];
      if (!next || next.fire_at_ms > target) break;
      this.timers.shift();
      this.now_ms = next.fire_at_ms;
      next.cb();
    }
    this.now_ms = target;
  }
}
