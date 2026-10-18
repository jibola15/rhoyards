import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(
      JSON.stringify({
        data: { status: 'ok', service: 'rhoyards-api', version: '0.1.0', uptimeSeconds: 5, time: new Date().toISOString() },
      }),
      { status: 200 },
    ),
  );
});

describe('AppLayout', () => {
  it('renders navigation, top bar and the main landmark', () => {
    renderApp('/');
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'System status' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('collapses the sidebar and remembers the preference', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true');
  });

  it('toggles dark mode', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('shows a not-found page for unknown routes', () => {
    renderApp('/nope');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
