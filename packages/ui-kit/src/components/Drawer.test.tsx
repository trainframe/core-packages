import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Drawer } from './Drawer.js';

describe('Drawer', () => {
  it('renders the toggle button with the given label', () => {
    render(<Drawer label="Developer">options</Drawer>);
    expect(screen.getByRole('button', { name: /developer/i })).toBeInTheDocument();
  });

  it('starts collapsed by default', () => {
    render(<Drawer label="Developer">hidden content</Drawer>);
    expect(screen.queryByText('hidden content')).not.toBeInTheDocument();
  });

  it('toggle button starts with aria-expanded=false when collapsed', () => {
    render(<Drawer label="Developer">content</Drawer>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on toggle button click', async () => {
    const user = userEvent.setup();
    render(<Drawer label="Developer">revealed content</Drawer>);
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('revealed content')).toBeInTheDocument();
  });

  it('toggle button has aria-expanded=true when open', async () => {
    const user = userEvent.setup();
    render(<Drawer label="Developer">content</Drawer>);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes again on second click', async () => {
    const user = userEvent.setup();
    render(<Drawer label="Developer">content</Drawer>);
    const toggle = screen.getByRole('button');
    await user.click(toggle);
    expect(screen.getByText('content')).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('starts open when defaultOpen=true', () => {
    render(
      <Drawer label="Developer" defaultOpen>
        visible content
      </Drawer>,
    );
    expect(screen.getByText('visible content')).toBeInTheDocument();
  });

  it('applies tf-drawer base class', () => {
    const { container } = render(<Drawer label="Dev">body</Drawer>);
    expect(container.firstChild).toHaveClass('tf-drawer');
  });

  it('forwards additional className', () => {
    const { container } = render(
      <Drawer label="Dev" className="extra">
        body
      </Drawer>,
    );
    expect(container.firstChild).toHaveClass('extra');
  });
});
