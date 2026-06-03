import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Panel } from './Panel.js';

describe('Panel', () => {
  it('renders children', () => {
    render(<Panel>content</Panel>);
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('renders label when provided', () => {
    render(<Panel label="Controls">body</Panel>);
    expect(screen.getByText('Controls')).toBeInTheDocument();
  });

  it('omits label element when label is not provided', () => {
    const { container } = render(<Panel>body</Panel>);
    expect(container.querySelector('.tf-panel__label')).not.toBeInTheDocument();
  });

  it('applies the tf-panel base class', () => {
    const { container } = render(<Panel>body</Panel>);
    expect(container.firstChild).toHaveClass('tf-panel');
  });

  it('forwards additional className', () => {
    const { container } = render(<Panel className="sidebar">body</Panel>);
    expect(container.firstChild).toHaveClass('sidebar');
  });

  it('forwards native div props', () => {
    render(
      <Panel aria-label="my panel" data-testid="panel">
        body
      </Panel>,
    );
    expect(screen.getByTestId('panel')).toHaveAttribute('aria-label', 'my panel');
  });
});
