import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { installUpdateHandling, NewVersionBanner, Toaster } from '@rhoyards/ui';
import { CustomerProvider } from './account/CustomerProvider';
import { createQueryClient } from './lib/query-client';
import { routes } from './routes';
import './index.css';

installUpdateHandling();
const queryClient = createQueryClient();
const router = createBrowserRouter(routes);

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <CustomerProvider>
        <RouterProvider router={router} />
        <Toaster />
        <NewVersionBanner />
      </CustomerProvider>
    </QueryClientProvider>
  </StrictMode>,
);
