export type NavCurrent = 'home' | 'chat' | 'none';

const HOME_AREA = [
  '/home',
  '/serve',
  '/request',
  '/requests',
  '/resources',
  '/check-in',
  '/consents',
  '/trusted-contacts',
];

/** Which primary nav item a path belongs to. Notifications and crisis belong to neither. */
export function navCurrent(pathname: string): NavCurrent {
  if (pathname === '/chat' || pathname.startsWith('/chat/')) return 'chat';
  const inHome = HOME_AREA.some((base) => pathname === base || pathname.startsWith(`${base}/`));
  return inHome ? 'home' : 'none';
}
