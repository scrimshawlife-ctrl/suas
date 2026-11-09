import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { CrisisStrip } from '../components/CrisisStrip';
import { Page } from '../components/Page';

/**
 * The Harbor crisis band above a screen that renders outside every layout (root error,
 * hydrate fallback, guard loading), so a veteran never sees one without it.
 */
export function WithCrisisStrip({ children }: { children: ReactNode }) {
  return (
    <>
      <CrisisStrip />
      {children}
    </>
  );
}

export function LoadingScreen() {
  return (
    <Page>
      <p role="status" className="text-slate">
        Loading…
      </p>
    </Page>
  );
}

export function LoadFailedScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <Page width="narrow">
      <h1 className="heading text-32">We could not load your account.</h1>
      <p className="text-slate">Check your connection and try again.</p>
      <div className="flex">
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </Page>
  );
}

/** The router's `HydrateFallback`: the first load, before any layout has rendered. */
export function HydrateFallbackScreen() {
  return (
    <WithCrisisStrip>
      <LoadingScreen />
    </WithCrisisStrip>
  );
}
