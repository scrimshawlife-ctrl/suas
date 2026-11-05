import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SkipLink } from './SkipLink';

describe('SkipLink', () => {
  it('is the first stop and moves focus into the main region', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink />
        <button>Header action</button>
        <main id="main">
          <button>First in main</button>
        </main>
      </>,
    );
    await user.tab();
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    expect(link).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'First in main' })).toHaveFocus();
  });
});
