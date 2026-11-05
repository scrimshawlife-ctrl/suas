import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AvatarMenu } from './AvatarMenu';

describe('AvatarMenu', () => {
  it('Escape closes the panel and returns focus to the button when focus was inside', async () => {
    const user = userEvent.setup();
    render(<AvatarMenu displayName="Marcus T." onSignOut={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Account and sign out for Marcus' });
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes when focus moves past the panel', async () => {
    const user = userEvent.setup();
    render(
      <>
        <AvatarMenu displayName="Marcus T." onSignOut={vi.fn()} />
        <button>After</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: /Account and sign out/ }));
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
