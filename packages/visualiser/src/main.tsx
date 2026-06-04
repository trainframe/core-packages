// Theme bootstrap — run before React mounts so there's no flash of wrong colours.
// The user's preference is stored in localStorage under 'tf-theme'.
// Activate dark mode: localStorage.setItem('tf-theme', 'dark') + reload
// or: document.documentElement.dataset.theme = 'dark'
(() => {
  const stored = localStorage.getItem('tf-theme');
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored;
  }
})();

import '@trainframe/ui-kit/theme-light.css';
import '@trainframe/ui-kit/theme-dark.css';
import './theme/light.css';
import './theme/dark.css';
import './visualiser.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
