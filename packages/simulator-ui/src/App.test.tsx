import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';
import { InMemoryBrokerClient } from './broker/in-memory-client.js';

describe('App', () => {
  it('renders the toy table heading', () => {
    render(<App client={new InMemoryBrokerClient()} />);
    expect(screen.getByRole('heading', { name: /trainframe toy table/i })).toBeInTheDocument();
  });

  it('reflects broker connection state in the connection status pill', () => {
    const client = new InMemoryBrokerClient();
    render(<App client={client} />);

    expect(screen.getByRole('status')).toHaveTextContent(/connected/i);
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'connected');
  });

  it('shows an error message when the broker reports an error', () => {
    const client = new InMemoryBrokerClient();
    render(<App client={client} />);

    act(() => client.fail(new Error('socket closed')));

    expect(screen.getByRole('status')).toHaveTextContent(/connection error.*socket closed/i);
  });
});
