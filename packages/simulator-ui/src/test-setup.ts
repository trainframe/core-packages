import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  /* `localStorage` only exists under the jsdom environment; node-environment
   *  files (e.g. the aedes-broker platform tests) have no DOM to clear. */
  if (typeof localStorage !== 'undefined') localStorage.clear();
});
