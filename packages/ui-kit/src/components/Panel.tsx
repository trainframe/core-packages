import type { HTMLAttributes, ReactNode } from 'react';
import './Panel.css';

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
  children: ReactNode;
}

/**
 * A labelled box for grouping controls. Used for sidebars and drawers.
 *
 * When `label` is provided it is rendered as a small all-caps heading above
 * the panel body, styled via CSS custom properties from the theme files.
 */
export function Panel({ label, className, children, ...rest }: PanelProps) {
  const classes = ['tf-panel', className].filter(Boolean).join(' ');
  return (
    <div className={classes} {...rest}>
      {label !== undefined ? <span className="tf-panel__label">{label}</span> : null}
      {children}
    </div>
  );
}
