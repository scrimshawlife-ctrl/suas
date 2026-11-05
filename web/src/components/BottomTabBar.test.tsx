import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { BottomTabBar } from './BottomTabBar';

describe('BottomTabBar', () => {
  it('shows the unread count on Chat, and nothing when there is none', () => {
    const { rerender } = render(
      <MemoryRouter>
        <BottomTabBar mode="support" current="home" chatUnread={2} embedded />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('2 unread')).toHaveTextContent('2');
    rerender(
      <MemoryRouter>
        <BottomTabBar mode="support" current="home" chatUnread={0} embedded />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText(/unread/)).toBeNull();
  });
});
