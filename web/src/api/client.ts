import createClient, { type Middleware } from 'openapi-fetch';
import { apiErrorFromResponse, GATE_CODES } from './errors';
import type { ApiPaths } from './client-types';
import { tokenStore as defaultTokenStore, type TokenStore } from './token-store';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Sign-in endpoints answer 401 for a wrong code, and logout answers 401 when the session is
 * already gone. Neither is an expiry to redirect on: sign-out ends on "/" by itself.
 */
function isAuthPath(schemaPath: string): boolean {
  return (
    schemaPath.startsWith('/api/v0/auth/challenges') ||
    // A wrong MFA response is a 401 too; it must not end the session.
    schemaPath.startsWith('/api/v0/auth/mfa/') ||
    schemaPath === '/api/v0/auth/sessions/commands/logout'
  );
}

export interface ApiClientOptions {
  baseUrl?: string;
  tokenStore?: TokenStore;
  /** Called after a 401 on a signed-in request, once the token is cleared. */
  onUnauthorized?: () => void;
  /** Called after an MFA_REQUIRED error, once the client MFA flag is cleared. */
  onMfaRequired?: () => void;
  fetch?: (input: Request) => Promise<Response>;
  newIdempotencyKey?: () => string;
}

/** Hard navigation fallback; the app registers a router based redirect instead. */
function redirectToSignIn(): void {
  if (window.location.pathname !== '/sign-in') window.location.assign('/sign-in');
}

let unauthorizedHandler: () => void = redirectToSignIn;
let mfaRequiredHandler: () => void = () => {
  if (window.location.pathname !== '/admin/mfa') window.location.assign('/admin/mfa');
};

/** The app registers its router navigation here so a 401 does not reload the page. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler ?? redirectToSignIn;
}

/** Same for MFA_REQUIRED: the app sends the person to the step-up screen. */
export function setMfaRequiredHandler(handler: (() => void) | null): void {
  mfaRequiredHandler =
    handler ??
    (() => {
      if (window.location.pathname !== '/admin/mfa') window.location.assign('/admin/mfa');
    });
}

export function createApiMiddleware(options: ApiClientOptions = {}): Middleware {
  const store = options.tokenStore ?? defaultTokenStore;
  const newKey = options.newIdempotencyKey ?? (() => crypto.randomUUID());
  const onUnauthorized = options.onUnauthorized ?? (() => unauthorizedHandler());
  const onMfaRequired = options.onMfaRequired ?? (() => mfaRequiredHandler());

  return {
    onRequest({ request }) {
      const token = store.getToken();
      if (token !== null && !request.headers.has('Authorization')) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
      if (WRITE_METHODS.has(request.method) && !request.headers.has('Idempotency-Key')) {
        request.headers.set('Idempotency-Key', newKey());
      }
      return request;
    },
    async onResponse({ request, response, schemaPath }) {
      if (response.ok) return response;
      const error = await apiErrorFromResponse(response);
      const hadSession = request.headers.has('Authorization');
      if (response.status === 401 && hadSession && !isAuthPath(schemaPath)) {
        store.clear();
        onUnauthorized();
      } else if (error.code === GATE_CODES.mfaRequired) {
        store.setMfaElevated(false);
        onMfaRequired();
      }
      throw error;
    },
  };
}

export function createApiClient(options: ApiClientOptions = {}) {
  const client = createClient<ApiPaths>({
    baseUrl: options.baseUrl ?? import.meta.env.VITE_SUAS_API_BASE_URL ?? '',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  client.use(createApiMiddleware(options));
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** The app wide client. Failures reject with `ApiError`. */
export const api: ApiClient = createApiClient();
