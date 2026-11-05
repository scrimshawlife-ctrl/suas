import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { FocusRescue, RouteFocus } from './RouteFocus';

function Shell() {
  return (
    <>
      <RouteFocus />
      <Link to="/other">Other</Link>
      <Link to="/start?tab=2">Same page</Link>
      <main id="main">
        <Outlet />
      </main>
    </>
  );
}

function renderApp(late = false) {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/start', element: <h1>Start page</h1> },
          { path: '/other', element: late ? <p>Loading</p> : <h1>Other page</h1> },
        ],
      },
    ],
    { initialEntries: ['/start'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('RouteFocus', () => {
  it('leaves focus alone on the first load', () => {
    renderApp();
    expect(document.body).toHaveFocus();
  });

  it('moves focus to the new page heading after a route change', async () => {
    const router = renderApp();
    await act(() => router.navigate('/other'));
    expect(screen.getByRole('heading', { level: 1, name: 'Other page' })).toHaveFocus();
  });

  it('keeps focus when only the query string changes', async () => {
    const router = renderApp();
    screen.getByRole('link', { name: 'Same page' }).focus();
    await act(() => router.navigate('/start?tab=2'));
    expect(screen.getByRole('link', { name: 'Same page' })).toHaveFocus();
  });

  it('focuses the main region while loading, then the heading once it appears', async () => {
    const router = renderApp(true);
    await act(() => router.navigate('/other'));
    expect(screen.getByRole('main')).toHaveFocus();
    // The screen finishes loading: its heading arrives and takes focus.
    await act(async () => {
      const heading = document.createElement('h1');
      heading.textContent = 'Loaded';
      screen.getByRole('main').appendChild(heading);
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Loaded' })).toHaveFocus();
  });
});

function Replaceable() {
  const [done, setDone] = useState(false);
  return (
    <>
      <FocusRescue />
      <button>Before</button>
      <section aria-label="Card">
        {done ? <p>Done</p> : <button onClick={() => setDone(true)}>Start</button>}
      </section>
    </>
  );
}

describe('FocusRescue', () => {
  it('keeps focus in the card when the focused button is replaced', async () => {
    const user = userEvent.setup();
    render(<Replaceable />);
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Card' })).toHaveFocus();
  });
});
