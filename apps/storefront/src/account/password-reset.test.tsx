import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderStore, unauthenticated } from '../test/render';

const info = {
  name: 'Rhoyards',
  phone: null,
  email: null,
  address: null,
  currency: { code: 'NGN', symbol: '₦' },
  pricesIncludeTax: true,
  onlineEnabled: true,
  providers: [],
};

describe('shopper password reset', () => {
  it('links from sign-in to a request form that does not reveal whether the account exists', async () => {
    let sent: unknown;
    mockApi({
      'GET /auth/me': unauthenticated,
      'GET /info': () => json(200, { data: info }),
      'POST /auth/password-reset': (_u, init) => {
        sent = JSON.parse(String(init.body));
        return json(202, { data: { message: 'ok' } });
      },
    });
    renderStore('/account/login');
    fireEvent.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'Ada@Shop.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account uses that email/)).toBeInTheDocument();
    expect(sent).toEqual({ email: 'ada@shop.test' });
  });

  it('sets a new password from the emailed link and shows an expired link clearly', async () => {
    const token = 't'.repeat(43);
    let attempts = 0;
    mockApi({
      'GET /auth/me': unauthenticated,
      'GET /info': () => json(200, { data: info }),
      'POST /auth/password-reset/confirm': () => {
        attempts += 1;
        return attempts === 1
          ? json(422, { error: { code: 'BUSINESS_RULE', message: 'This reset link is invalid or has expired. Please request a new one.' } })
          : new Response(null, { status: 204 });
      },
    });
    window.history.replaceState(null, '', `/account/reset-password#token=${token}`);
    renderStore('/account/reset-password');
    expect(window.location.hash).toBe('');
    fireEvent.change(await screen.findByLabelText('New password (at least 8 characters)'), { target: { value: 'new-pass-123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/Your password has been changed/)).toBeInTheDocument();
  });
});
