/**
 * Broker URL persistence. The simulator UI is a static shell — every install
 * configures its own broker URL locally. We use `localStorage` so the choice
 * survives reloads without any server-side state.
 */

const STORAGE_KEY = 'trainframe.simulator-ui.brokerUrl';
export const DEFAULT_BROKER_URL = 'ws://localhost:9001';

export function loadBrokerUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_BROKER_URL;
  } catch {
    return DEFAULT_BROKER_URL;
  }
}

export function saveBrokerUrl(url: string): void {
  localStorage.setItem(STORAGE_KEY, url);
}

export function clearBrokerUrl(): void {
  localStorage.removeItem(STORAGE_KEY);
}
