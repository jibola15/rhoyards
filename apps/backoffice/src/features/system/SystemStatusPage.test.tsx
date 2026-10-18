import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render';

const healthy = () =>
  new Response(
    JSON.stringify({
      data: { status: 'ok', service: 'rhoyards-api', version: '0.1.0', uptimeSeconds: 3725, time: new Date().toISOString() },
    }),
    { status: 200 },
  );

describe('SystemStatusPage', () => {
  it('shows live API details when the API responds', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => healthy());
    renderApp('/');
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/health', expect.anything());
  });

  it('shows an error with a working retry when the API is down', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))
      .mockResolvedValueOnce(healthy());
    const user = userEvent.setup();
    renderApp('/');

    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed with status 502');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
