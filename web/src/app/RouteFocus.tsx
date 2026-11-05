import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/** How long to wait for a screen that is still loading to show its heading. */
const HEADING_WAIT_MS = 4000;

function focusTarget(target: HTMLElement) {
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: false });
}

/**
 * After a route change (not the first load), move focus to the page's main heading, or to
 * the main region while the screen is still loading, so keyboard and screen-reader users
 * start at the top of the new page instead of on a link that no longer exists. If the
 * heading appears later and the person has not moved focus, it moves there.
 *
 * A screen can name a better target with `data-route-focus` (the chat conversation title).
 * Only the path counts: a change to the query string or to the in-page state keeps focus.
 * With the two-pane chat (861 px and up), picking a thread keeps focus in the list.
 */
export function RouteFocus() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);

  useEffect(() => {
    const from = previous.current;
    previous.current = pathname;
    if (from === pathname) return;
    if (
      from.startsWith('/chat') &&
      pathname.startsWith('/chat') &&
      window.matchMedia('(min-width: 861px)').matches
    ) {
      return;
    }

    const main = document.getElementById('main');
    if (main === null) return;
    const heading = () =>
      main.querySelector<HTMLElement>('[data-route-focus]') ??
      main.querySelector<HTMLElement>('h1');

    const found = heading();
    if (found !== null) {
      focusTarget(found);
      return;
    }
    focusTarget(main);
    const observer = new MutationObserver(() => {
      const late = heading();
      if (late === null) return;
      observer.disconnect();
      // Leave focus alone if the person already moved it somewhere inside the page.
      if (document.activeElement === main || document.activeElement === document.body) {
        focusTarget(late);
      }
    });
    observer.observe(main, { childList: true, subtree: true });
    const timer = window.setTimeout(() => observer.disconnect(), HEADING_WAIT_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [pathname]);

  return null;
}
