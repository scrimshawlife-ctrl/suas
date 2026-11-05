import { Button } from '../components/Button';
import { Page } from '../components/Page';
import { paths } from './paths';

export default function NotFoundPage() {
  return (
    <Page width="narrow">
      <h1 className="heading text-44 max-sm:text-32">We could not find that page.</h1>
      <p className="text-slate">The link may be old or mistyped.</p>
      <div className="flex">
        <Button href={paths.landing}>Go to the start</Button>
      </div>
    </Page>
  );
}
