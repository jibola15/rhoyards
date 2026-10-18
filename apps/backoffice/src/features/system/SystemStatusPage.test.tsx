import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderApp, sessionFor } from '../../test/render';

const healthy = () =>
  json(200, { data: { status: 'ok', service: 'rhoyards-api', version: '0.1.0', uptimeSeconds: 3725, time: new Date().toISOString() } });
const me = () => json(200, { data: sessionFor([]) });

describe('SystemStatusPage', () => {
  it('shows live API details when the API responds', async () => {
    mockApi({ 'GET /auth/me': me, 'GET /health': healthy });
    renderApp('/');
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
  });

  it('shows an error with a working retry when the API is down', async () => {
    let calls = 0;
    mockApi({
      'GET /auth/me': me,
      'GET /health': () => (++calls === 1 ? new Response('Bad gateway', { status: 502 }) : healthy()),
    });
    const user = userEvent.setup();
    renderApp('/');

    expect(await screen.findByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed with status 502');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});
