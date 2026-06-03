// Components
export { Button } from './components/Button.js';
export type { ButtonProps, ButtonVariant } from './components/Button.js';

export { Panel } from './components/Panel.js';
export type { PanelProps } from './components/Panel.js';

export { Drawer } from './components/Drawer.js';
export type { DrawerProps } from './components/Drawer.js';

// Theme CSS — consumers import whichever they need:
//   import '@trainframe/ui-kit/src/theme-light.css';
//   import '@trainframe/ui-kit/src/theme-dark.css';
// Both can be imported together; the data-theme attribute on <html> selects which wins.
