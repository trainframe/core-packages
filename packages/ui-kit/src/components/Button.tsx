import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

/**
 * A minimal styled button with three semantic variants.
 *
 * Theming is done via CSS custom properties defined in theme-light.css /
 * theme-dark.css and switched by the document's `data-theme` attribute.
 * No runtime style objects — just class names.
 */
export function Button({ type, variant = 'primary', className, children, ...rest }: ButtonProps) {
  const variantClass = `tf-button--${variant}`;
  const classes = ['tf-button', variantClass, className].filter(Boolean).join(' ');
  return (
    <button type={type ?? 'button'} className={classes} {...rest}>
      {children}
    </button>
  );
}
