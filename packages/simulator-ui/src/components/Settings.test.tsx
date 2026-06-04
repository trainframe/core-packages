import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import { Settings } from './Settings.js';

function renderSettings(client: InMemoryBrokerClient) {
  render(
    <BrokerProvider client={client}>
      <Settings initialUrl="ws://localhost:9001" />
    </BrokerProvider>,
  );
}

describe('Settings cog + popover', () => {
  it('panel is closed by default when broker is connected', () => {
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    // <dialog> without `open` attribute is visually hidden.
    const panel = screen.getByTestId('settings-panel');
    expect(panel).not.toHaveAttribute('open');
  });

  it('clicking the cog opens the panel', async () => {
    const user = userEvent.setup();
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    const cog = screen.getByRole('button', { name: /settings/i });
    expect(cog).toHaveAttribute('aria-expanded', 'false');

    await user.click(cog);

    const panel = screen.getByTestId('settings-panel');
    expect(panel).toHaveAttribute('open');
    expect(cog).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking the cog again closes the panel (toggle)', async () => {
    const user = userEvent.setup();
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    const cog = screen.getByRole('button', { name: /settings/i });
    await user.click(cog);
    await user.click(cog);

    const panel = screen.getByTestId('settings-panel');
    expect(panel).not.toHaveAttribute('open');
    expect(cog).toHaveAttribute('aria-expanded', 'false');
  });

  it('pressing Escape closes the panel', async () => {
    const user = userEvent.setup();
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    const cog = screen.getByRole('button', { name: /settings/i });
    await user.click(cog);

    // Panel is open; press Escape.
    await user.keyboard('{Escape}');

    const panel = screen.getByTestId('settings-panel');
    expect(panel).not.toHaveAttribute('open');
  });

  it('panel auto-opens when broker transitions to error state', () => {
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    // Panel starts closed.
    expect(screen.getByTestId('settings-panel')).not.toHaveAttribute('open');

    // Simulate a broker error.
    act(() => {
      client.fail(new Error('ECONNREFUSED'));
    });

    // Panel should open automatically.
    expect(screen.getByTestId('settings-panel')).toHaveAttribute('open');
  });

  it('cog shows error badge when broker is in error state', () => {
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    // No badge initially.
    expect(screen.queryByTestId('settings-error-badge')).toBeNull();

    act(() => {
      client.fail(new Error('ECONNREFUSED'));
    });

    // Badge appears.
    expect(screen.getByTestId('settings-error-badge')).toBeTruthy();
  });

  it('cog has --error modifier class when broker is in error state', () => {
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    const cog = screen.getByTestId('settings-cog');
    expect(cog.classList.contains('tf-settings__cog--error')).toBe(false);

    act(() => {
      client.fail(new Error('ECONNREFUSED'));
    });

    expect(cog.classList.contains('tf-settings__cog--error')).toBe(true);
  });

  it('error alert in the form is only rendered when broker is in error state', async () => {
    const user = userEvent.setup();
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    // Open the panel.
    await user.click(screen.getByRole('button', { name: /settings/i }));

    // No alert yet.
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      client.fail(new Error("Couldn't reach the broker — check the URL."));
    });

    // Alert appears.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/broker/i);
  });

  it('form fields are in the DOM when panel is closed (native <dialog> keeps content mounted)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    // <dialog> without `open` keeps content in the DOM.
    // Use getAllByRole with hidden:true to confirm element exists even when not displayed.
    const allInputs = screen.getAllByRole('textbox', { hidden: true });
    expect(allInputs.length).toBeGreaterThan(0);
  });

  it('Connect button submits the form and calls client.connect', async () => {
    const user = userEvent.setup();
    const client = new InMemoryBrokerClient();
    client.connect('ws://localhost:9001');
    renderSettings(client);

    // Open panel.
    await user.click(screen.getByRole('button', { name: /settings/i }));

    // Clear and type a new URL.
    const input = screen.getByRole('textbox', { name: /broker url/i });
    await user.clear(input);
    await user.type(input, 'ws://localhost:9002');

    await user.click(screen.getByRole('button', { name: /connect/i }));

    // The configured URL shown below the form should update.
    expect(screen.getByText(/ws:\/\/localhost:9002/)).toBeTruthy();
  });
});
