import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import { InMemoryBrokerSubscriber } from './broker/in-memory-client.js';
import { loadBrokerUrl, saveBrokerUrl } from './config/broker-config.js';

describe('App', () => {
  it('renders the visualiser heading', () => {
    render(<App client={new InMemoryBrokerSubscriber()} />);
    expect(screen.getByRole('heading', { name: /trainframe visualiser/i })).toBeInTheDocument();
  });

  it('connects to the stored broker URL on mount and reflects the connection in the UI', () => {
    saveBrokerUrl('ws://stored.example:9001');
    const client = new InMemoryBrokerSubscriber();

    render(<App client={client} />);

    expect(screen.getByRole('status')).toHaveTextContent(/connected/i);
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'connected');
    expect(screen.getByText(/ws:\/\/stored\.example:9001/)).toBeInTheDocument();
  });

  it('persists a new broker URL when the user submits the settings form', async () => {
    const user = userEvent.setup();
    render(<App client={new InMemoryBrokerSubscriber()} />);

    const input = screen.getByLabelText(/broker url/i);
    await user.clear(input);
    await user.type(input, 'ws://newhost:9001');
    await user.click(screen.getByRole('button', { name: /connect/i }));

    expect(loadBrokerUrl()).toBe('ws://newhost:9001');
  });

  it('shows an error message when the broker reports an error', () => {
    const client = new InMemoryBrokerSubscriber();
    render(<App client={client} />);

    act(() => client.fail(new Error('socket closed')));

    expect(screen.getByRole('status')).toHaveTextContent(/connection error.*socket closed/i);
  });
});
