import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { setUnauthorizedHandler } from './api/client';
import { createQueryClient } from './app/query-client';
import { createAppRouter } from './app/router';
import { paths } from './app/paths';
import './index.css';

const queryClient = createQueryClient();
const router = createAppRouter();

// A 401 on a signed-in request has already cleared the token; drop cached data and sign in again.
setUnauthorizedHandler(() => {
  queryClient.clear();
  void router.navigate(paths.signIn, { replace: true });
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
