import { Button } from '../components/Button';
import { Page } from '../components/Page';

/** Shown when a route fails to load (for example a dropped connection while fetching a screen). */
export default function RouteErrorPage() {
  return (
    <Page width="narrow">
      <h1 className="heading text-32">Something went wrong.</h1>
      <p className="text-slate">Reload the page to try again.</p>
      <div className="flex">
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </Page>
  );
}
