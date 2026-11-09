import { Button } from '../components/Button';
import { CrisisStrip } from '../components/CrisisStrip';
import { Page } from '../components/Page';

/**
 * Shown when a route fails to load (for example a dropped connection while fetching a screen).
 * It sits outside every layout, so it carries the crisis strip itself.
 */
export default function RouteErrorPage() {
  return (
    <>
      <CrisisStrip />
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
    </>
  );
}
