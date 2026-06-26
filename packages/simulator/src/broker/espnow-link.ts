/**
 * The ESP-NOW link — the constrained radio segment a device and its bridge talk
 * over before (and after) pairing (ADR-035 Phase 2). This is the ONLY mocked
 * thing in the pairing model: an in-memory medium that models the *logical* link
 * semantics — address-less broadcast (how an unpaired device announces itself)
 * and directed send (once the bridge has named it) — NOT the radio physics
 * (channels, retransmission, power). YAGNI: just enough to drive the
 * announce → discover → associate → register handshake and its failure modes.
 *
 * Deterministic: synchronous fan-out, insertion-ordered, no timers, no RNG. Test
 * knobs (`dropNext`, `buffer`/`flush`) let a test drop or reorder deliveries to
 * exercise a lost announce/ack or an out-of-order frame.
 */

/** A peer's address on the segment — a MAC, modelled as an opaque string. */
export type PeerId = string;

/** A frame as the receiver sees it: who sent it, whether it was a broadcast, and
 *  the opaque payload (the bridge/device encode/decode their own bytes). */
export interface LinkFrame {
  readonly from: PeerId;
  readonly broadcast: boolean;
  readonly payload: Uint8Array;
}

/** The device-side (and bridge-side) view of the radio. */
export interface EspNowLink {
  readonly id: PeerId;
  /** Address-less broadcast — reaches every other peer. Used by an unpaired
   *  device to announce itself when it knows no one's address. */
  broadcast(payload: Uint8Array): void;
  /** Directed send to a known peer (post-pairing). A no-op if the peer is absent. */
  sendTo(peer: PeerId, payload: Uint8Array): void;
  /** Receive frames addressed to this peer (directed) or broadcast by others.
   *  Returns an unsubscribe. Never delivers a peer its own frames. */
  onReceive(handler: (frame: LinkFrame) => void): () => void;
}

type Delivery = () => void;

/**
 * An in-memory ESP-NOW medium connecting peers synchronously. Create a peer's
 * link with `peer(id)`.
 */
export class InMemoryEspNow {
  private readonly handlers = new Map<PeerId, Set<(frame: LinkFrame) => void>>();
  private dropCount = 0;
  private pending: Delivery[] | null = null;

  /** Drop the next `n` deliveries (modelling lost frames). */
  dropNext(n = 1): void {
    this.dropCount += n;
  }

  /** Begin buffering deliveries instead of dispatching them immediately. */
  buffer(): void {
    this.pending ??= [];
  }

  /** Dispatch buffered deliveries. `order` may permute them (modelling reorder);
   *  default is insertion order. Returns to immediate-dispatch mode. */
  flush(order?: (count: number) => ReadonlyArray<number>): void {
    const queued = this.pending ?? [];
    this.pending = null;
    const indices = order ? order(queued.length) : queued.map((_, i) => i);
    for (const i of indices) queued[i]?.();
  }

  peer(id: PeerId): EspNowLink {
    if (!this.handlers.has(id)) this.handlers.set(id, new Set());
    const medium = this;
    return {
      id,
      broadcast(payload: Uint8Array): void {
        medium.send(id, undefined, payload);
      },
      sendTo(peer: PeerId, payload: Uint8Array): void {
        medium.send(id, peer, payload);
      },
      onReceive(handler: (frame: LinkFrame) => void): () => void {
        const set = medium.handlers.get(id);
        set?.add(handler);
        return () => {
          set?.delete(handler);
        };
      },
    };
  }

  private send(from: PeerId, to: PeerId | undefined, payload: Uint8Array): void {
    const broadcast = to === undefined;
    const targets = broadcast ? [...this.handlers.keys()].filter((p) => p !== from) : [to];
    for (const target of targets) {
      const set = this.handlers.get(target);
      if (set === undefined) continue; // peer absent — frame lost
      const frame: LinkFrame = { from, broadcast, payload };
      const deliver: Delivery = () => {
        for (const handler of [...set]) handler(frame);
      };
      if (this.dropCount > 0) {
        this.dropCount -= 1; // drop this delivery
        continue;
      }
      if (this.pending !== null) this.pending.push(deliver);
      else deliver();
    }
  }
}
