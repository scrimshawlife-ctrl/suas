import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import RouteErrorPage from './RouteErrorPage';
import { HydrateFallbackScreen } from './status-screens';

// Both screens render outside every layout, so each must bring its own band and footer (AT07).
const screens: [string, ReactElement][] = [
  ['RouteErrorPage', <RouteErrorPage />],
  ['HydrateFallbackScreen', <HydrateFallbackScreen />],
];

/** The crisis destinations; band and footer are checked separately so each keeps its own set. */
const destinations = [
  ['Call 911', 'tel:911'],
  ['Call 988', 'tel:988'],
  ['Text 988', 'sms:988'],
  ['Veterans Crisis Line: Text 838255', 'sms:838255'],
] as const;

describe.each(screens)('%s', (_name, ui) => {
  it('renders the crisis band and the SAFETY_COPY.md §2.3 persistent footer', () => {
    render(ui);
    const band = screen.getByRole('complementary', { name: 'Crisis support' });
    const footer = screen.getByRole('contentinfo');
    for (const region of [band, footer]) {
      for (const [name, href] of destinations) {
        expect(within(region).getByRole('link', { name })).toHaveAttribute('href', href);
      }
    }
    expect(footer).toHaveTextContent(
      'SUAS coordinates community support. It does not provide emergency medical care or emergency dispatch.',
    );
  });
});
