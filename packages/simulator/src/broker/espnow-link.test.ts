import { describe, expect, it } from 'vitest';
import { InMemoryEspNow, type LinkFrame } from './espnow-link.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (f: LinkFrame): string => new TextDecoder().decode(f.payload);

describe('InMemoryEspNow — the mockable pairing link (ADR-035)', () => {
  it('broadcast reaches every other peer but never the sender', () => {
    const air = new InMemoryEspNow();
    const a = air.peer('A');
    const bSeen: LinkFrame[] = [];
    const cSeen: LinkFrame[] = [];
    const aSeen: LinkFrame[] = [];
    air.peer('B').onReceive((f) => bSeen.push(f));
    air.peer('C').onReceive((f) => cSeen.push(f));
    a.onReceive((f) => aSeen.push(f));

    a.broadcast(bytes('hello'));

    expect(bSeen.map(text)).toEqual(['hello']);
    expect(cSeen.map(text)).toEqual(['hello']);
    expect(aSeen).toHaveLength(0); // never hears itself
    expect(bSeen[0]?.broadcast).toBe(true);
    expect(bSeen[0]?.from).toBe('A');
  });

  it('sendTo reaches only the addressed peer', () => {
    const air = new InMemoryEspNow();
    const bridge = air.peer('BRIDGE');
    const devSeen: LinkFrame[] = [];
    const otherSeen: LinkFrame[] = [];
    air.peer('DEV').onReceive((f) => devSeen.push(f));
    air.peer('OTHER').onReceive((f) => otherSeen.push(f));

    bridge.sendTo('DEV', bytes('ack'));

    expect(devSeen.map(text)).toEqual(['ack']);
    expect(otherSeen).toHaveLength(0);
    expect(devSeen[0]?.broadcast).toBe(false);
  });

  it('unsubscribe stops delivery; an absent peer silently loses the frame', () => {
    const air = new InMemoryEspNow();
    const seen: LinkFrame[] = [];
    const off = air.peer('DEV').onReceive((f) => seen.push(f));
    const bridge = air.peer('BRIDGE');
    bridge.sendTo('DEV', bytes('one'));
    off();
    bridge.sendTo('DEV', bytes('two'));
    expect(seen.map(text)).toEqual(['one']);
    expect(() => bridge.sendTo('GHOST', bytes('x'))).not.toThrow();
  });

  it('dropNext loses the next delivery (a lost announce/ack)', () => {
    const air = new InMemoryEspNow();
    const seen: LinkFrame[] = [];
    air.peer('DEV').onReceive((f) => seen.push(f));
    const bridge = air.peer('BRIDGE');
    air.dropNext(1);
    bridge.sendTo('DEV', bytes('lost'));
    bridge.sendTo('DEV', bytes('kept'));
    expect(seen.map(text)).toEqual(['kept']);
  });

  it('buffer + flush can reorder deliveries (an out-of-order frame)', () => {
    const air = new InMemoryEspNow();
    const seen: LinkFrame[] = [];
    air.peer('DEV').onReceive((f) => seen.push(f));
    const bridge = air.peer('BRIDGE');
    air.buffer();
    bridge.sendTo('DEV', bytes('first'));
    bridge.sendTo('DEV', bytes('second'));
    expect(seen).toHaveLength(0); // buffered, not yet delivered
    air.flush((n) => Array.from({ length: n }, (_, i) => n - 1 - i)); // reverse
    expect(seen.map(text)).toEqual(['second', 'first']);
  });
});
