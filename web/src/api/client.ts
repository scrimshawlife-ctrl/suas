import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError, apiErrorFromResponse, GATE_CODES, TIMEOUT_CODE } from './errors';
import type { ApiPaths } from './client-types';
import { tokenStore as defaultTokenStore, type TokenStore } from './token-store';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Every request gives up after this long (B2), so a hung fetch ends in an error, not "Loading…". */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Calls that wait on the model: up to 4 server model calls of up to 30 s each
 * (`src/intake/assistant.ts`, `src/inference/bedrock-inference.ts`), so the server's own
 * FALLBACK_FORM answer arrives well before this.
 */
export const MODEL_REQUEST_TIMEOUT_MS = 150_000;
const MODEL_PATHS = new Set([
  '/api/v0/intake/drafts',
  '/api/v0/intake/drafts/{id}/messages',
  '/api/v0/admin/resource-drafts/commands/extract',
]);

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
    onRequest({ request, schemaPath }) {
      const token = store.getToken();
      if (token !== null && !request.headers.has('Authorization')) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
      if (WRITE_METHODS.has(request.method) && !request.headers.has('Idempotency-Key')) {
        request.headers.set('Idempotency-Key', newKey());
      }
      // The caller's signal still cancels; the timeout ends a request nobody answers.
      const limit =
        request.method === 'POST' && MODEL_PATHS.has(schemaPath)
          ? MODEL_REQUEST_TIMEOUT_MS
          : REQUEST_TIMEOUT_MS;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(limit)]);
      return new Request(request, { signal });
    },
    onError({ request }) {
      // Matched by name: under test the DOMException class comes from another realm.
      const reason = request.signal.reason as { name?: unknown } | undefined;
      if (reason?.name === 'TimeoutError') {
        // Screens that show `message` as is (sign-in, Welcome) get the connection advice too.
        return new ApiError(
          408,
          TIMEOUT_CODE,
          'SUAS did not answer in time. Check your connection and try again.',
        );
      }
      return undefined;
    },
    async onResponse({ request, response, schemaPath }) {
      if (response.ok) return response;
      const error = await apiErrorFromResponse(response);
      // Only a 401 for the token still in use is an expiry. A late answer to a request sent
      // before sign-out, or before an earlier 401 already handled this expiry, is not.
      const current = store.getToken();
      const sentCurrentToken =
        current !== null && request.headers.get('Authorization') === `Bearer ${current}`;
      if (response.status === 401 && sentCurrentToken && !isAuthPath(schemaPath)) {
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
