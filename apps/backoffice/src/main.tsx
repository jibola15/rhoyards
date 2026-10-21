import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { installUpdateHandling, NewVersionBanner, Toaster } from '@rhoyards/ui';
import { AuthProvider } from './auth/AuthProvider';
import { createQueryClient } from './lib/query-client';
import { routes } from './routes';
import './index.css';

installUpdateHandling();
const queryClient = createQueryClient();
// Matches Vite's `base` (e.g. /admin/ on Vercel, / elsewhere).
const router = createBrowserRouter(routes, { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' });

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toaster />
        <NewVersionBanner />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
