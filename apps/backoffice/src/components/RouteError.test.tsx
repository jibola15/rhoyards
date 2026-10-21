import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { NewVersionBanner, noteServerBuild } from '@rhoyards/ui';
import { RouteError } from './RouteError';

function Broken(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'salesTotal')");
}

describe('keeping open tabs in step with a release', () => {
  it('shows a plain error page with a way out instead of a stack trace', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const router = createMemoryRouter([{ path: '/', element: <Broken />, errorElement: <RouteError /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('heading', { name: 'Something went wrong on this page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByText(/reading 'salesTotal'/)).not.toBeVisible(); // inside closed "Technical details"
  });

  it('says the page was updated when a removed part of the app fails to load', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStorage.setItem('rhoyards.reloaded-for-update', '1'); // already reloaded once: show, do not loop
    function Stale(): never {
      throw new TypeError('Failed to fetch dynamically imported module: https://x/admin/assets/DashboardPage-old.js');
    }
    const router = createMemoryRouter([{ path: '/', element: <Stale />, errorElement: <RouteError /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('heading', { name: 'This page has been updated' })).toBeInTheDocument();
    sessionStorage.clear();
  });

  it('offers to reload once the server reports a different release', () => {
    render(<NewVersionBanner />);
    expect(screen.queryByText(/A new version of Rhoyards is available/)).toBeNull();
    act(() => noteServerBuild('abc123', 'abc123')); // same release
    expect(screen.queryByText(/A new version/)).toBeNull();
    act(() => noteServerBuild('def456', '')); // development: no check
    expect(screen.queryByText(/A new version/)).toBeNull();
    act(() => noteServerBuild('def456', 'abc123'));
    expect(screen.getByText(/A new version of Rhoyards is available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
