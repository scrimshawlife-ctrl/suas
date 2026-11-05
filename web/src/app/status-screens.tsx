import { Button } from '../components/Button';
import { Page } from '../components/Page';

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
