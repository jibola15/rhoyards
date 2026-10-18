import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from './routes';

function renderAt(path: string) {
  return render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />);
}

describe('storefront routes', () => {
  it('renders the home page inside the store layout', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Rhoyards' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('renders a not-found page for unknown paths', () => {
    renderAt('/missing');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home page' })).toHaveAttribute('href', '/');
  });
});
