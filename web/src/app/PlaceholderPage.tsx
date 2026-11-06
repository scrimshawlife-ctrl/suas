import { Page } from '../components/Page';

/**
 * Stand-in body for a screen that is built in a later sprint. The owner of the screen
 * replaces the page file under features/<area>/ and nothing else.
 */
export function PlaceholderPage({ title, route }: { title: string; route: string }) {
  return (
    <Page>
      <title>{`${title} · SUAS`}</title>
      <h1 className="heading text-44 max-sm:text-32">{title}</h1>
      <p className="text-slate">
        Placeholder for <code className="font-mono">{route}</code>. This screen is built next.
      </p>
    </Page>
  );
}
