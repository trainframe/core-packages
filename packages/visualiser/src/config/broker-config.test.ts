import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROKER_URL,
  clearBrokerUrl,
  loadBrokerUrl,
  saveBrokerUrl,
} from './broker-config.js';

describe('broker-config', () => {
  it('returns the default URL when nothing is stored', () => {
    expect(loadBrokerUrl()).toBe(DEFAULT_BROKER_URL);
  });

  it('round-trips a saved URL', () => {
    saveBrokerUrl('ws://192.168.1.42:9001');
    expect(loadBrokerUrl()).toBe('ws://192.168.1.42:9001');
  });

  it('falls back to the default after clearing', () => {
    saveBrokerUrl('ws://example/');
    clearBrokerUrl();
    expect(loadBrokerUrl()).toBe(DEFAULT_BROKER_URL);
  });
});
