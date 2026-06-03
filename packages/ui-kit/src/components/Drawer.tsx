import { type HTMLAttributes, type ReactNode, useState } from 'react';
import './Drawer.css';

export interface DrawerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Text shown on the toggle button. */
  label: string;
  /** Content displayed when the drawer is open. */
  children: ReactNode;
  /** Whether the drawer starts open. Defaults to false (collapsed). */
  defaultOpen?: boolean;
}

/**
 * A collapsible side panel. The toggle button is always visible; the body
 * slides in when open. Used to hide developer-only controls behind a toggle
 * so the primary UI surface stays clean.
 *
 * Controlled via internal state only — no external open/setOpen API yet.
 * Add it when a consumer needs it.
 */
export function Drawer({ label, className, children, defaultOpen = false, ...rest }: DrawerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const classes = ['tf-drawer', className].filter(Boolean).join(' ');
  const chevronClasses = ['tf-drawer__chevron', open ? 'tf-drawer__chevron--open' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...rest}>
      <button
        type="button"
        className="tf-drawer__toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {label}
        <span className={chevronClasses} aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? <div className="tf-drawer__body">{children}</div> : null}
    </div>
  );
}
