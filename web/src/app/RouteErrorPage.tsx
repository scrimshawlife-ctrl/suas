import { Button } from '../components/Button';
import { Page } from '../components/Page';
import { WithCrisisStrip } from './status-screens';

/**
 * Shown when a route fails to load (for example a dropped connection while fetching a screen).
 * It sits outside every layout, so it carries the crisis strip and footer itself.
 */
export default function RouteErrorPage() {
  return (
    <WithCrisisStrip>
      <main id="main">
        <Page width="narrow">
          <title>Something went wrong · SUAS</title>
          <h1 className="heading text-32">Something went wrong.</h1>
          <p className="text-slate">Reload the page to try again.</p>
          <div className="flex">
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </Page>
      </main>
    </WithCrisisStrip>
  );
}
