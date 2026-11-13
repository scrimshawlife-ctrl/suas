import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AvatarMenu } from './AvatarMenu';

const inRouter = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
const openMenu = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /Account and sign out/ }));

describe('AvatarMenu', () => {
  it('Escape closes the panel and returns focus to the button when focus was inside', async () => {
    const user = userEvent.setup();
    inRouter(<AvatarMenu displayName="Marcus T." onSignOut={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Account and sign out for Marcus' });
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes when focus moves past the panel', async () => {
    const user = userEvent.setup();
    inRouter(
      <>
        <AvatarMenu displayName="Marcus T." onSignOut={vi.fn()} />
        <button>After</button>
      </>,
    );
    await openMenu(user);
    // Settings, Invitations, Sign out, then out of the panel.
    for (let n = 0; n < 4; n += 1) await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('lists Settings and Invitations for everyone, and Admin console only for an admin (R12.4)', async () => {
    const user = userEvent.setup();
    const { unmount } = inRouter(<AvatarMenu displayName="Marcus T." onSignOut={vi.fn()} />);
    await openMenu(user);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Invitations' })).toHaveAttribute(
      'href',
      '/invitations',
    );
    expect(screen.queryByRole('link', { name: 'Admin console' })).toBeNull();
    unmount();

    inRouter(<AvatarMenu displayName="Marcus T." isAdmin onSignOut={vi.fn()} />);
    await openMenu(user);
    expect(screen.getByRole('link', { name: 'Admin console' })).toHaveAttribute('href', '/admin');
  });

  it('closes after a link is followed', async () => {
    const user = userEvent.setup();
    inRouter(<AvatarMenu displayName="Marcus T." onSignOut={vi.fn()} />);
    await openMenu(user);
    await user.click(screen.getByRole('link', { name: 'Invitations' }));
    expect(screen.queryByRole('link', { name: 'Invitations' })).toBeNull();
  });
});
