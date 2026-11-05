/**
 * Route paths. Link with these instead of string literals so a path change is one edit.
 * The table of who may open what lives in router.tsx.
 */
export const paths = {
  landing: '/',
  signIn: '/sign-in',
  signInCode: '/sign-in/code',
  welcome: '/welcome',
  verify: '/verify',
  crisis: '/crisis',
  home: '/home',
  request: '/request',
  requestDetail: (id: string) => `/requests/${id}`,
  resources: (category: string) => `/resources/${category}`,
  checkIn: '/check-in',
  consents: '/consents',
  trustedContacts: '/trusted-contacts',
  notifications: '/notifications',
  serve: '/serve',
  case: (id: string) => `/serve/requests/${id}`,
  chat: '/chat',
  chatThread: (serviceRequestId: string) => `/chat/${serviceRequestId}`,
  admin: '/admin',
  adminDrafts: '/admin/drafts',
  adminDraft: (id: string) => `/admin/drafts/${id}`,
  adminMfa: '/admin/mfa',
  devComponents: '/dev/components',
} as const;
