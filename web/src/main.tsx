import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { setMfaRequiredHandler, setUnauthorizedHandler } from './api/client';
import { createQueryClient } from './app/query-client';
import { createAppRouter } from './app/router';
import { paths } from './app/paths';
// Self-hosted fonts (no third-party requests, works under a strict CSP).
import '@fontsource/public-sans/600.css';
import '@fontsource/public-sans/700.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/400-italic.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './index.css';

const queryClient = createQueryClient();
const router = createAppRouter();

// A 401 on a signed-in request has already cleared the token; drop cached data and sign in
// again, remembering where the person was so sign-in can bring them back (genuine expiry only:
// sign-out never goes through here). Already on sign-in: keep the first return path.
setUnauthorizedHandler(() => {
  queryClient.clear();
  const { pathname, search } = router.state.location;
  if (pathname === paths.signIn) return;
  void router.navigate(paths.signIn, { replace: true, state: { from: `${pathname}${search}` } });
});

// MFA_REQUIRED has already cleared the client MFA flag; go to the step-up screen and come back.
setMfaRequiredHandler(() => {
  const { pathname, search } = router.state.location;
  if (pathname !== paths.adminMfa) {
    void router.navigate(paths.adminMfa, {
      replace: true,
      state: { from: `${pathname}${search}` },
    });
  }
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
