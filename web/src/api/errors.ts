/** Error envelope every `/api/v0` failure uses: `{ "error": { "code", "message" } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Gate codes the API returns that screens branch on. */
export const GATE_CODES = {
  verificationRequired: 'VERIFICATION_REQUIRED',
  countyRequired: 'COUNTY_REQUIRED',
  mfaRequired: 'MFA_REQUIRED',
  forbidden: 'FORBIDDEN',
} as const;

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function hasApiCode(value: unknown, code: string): boolean {
  return isApiError(value) && value.code === code;
}

/**
 * Builds an ApiError from a failed response. A body that is not the documented envelope
 * (a proxy error page, an empty 502) still yields a typed error with a stable code.
 */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || 'The request did not go through.';
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const envelope = (body as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof envelope?.code === 'string') code = envelope.code;
      if (typeof envelope?.message === 'string') message = envelope.message;
    }
  } catch {
    // Not JSON: keep the status based defaults.
  }
  return new ApiError(response.status, code, message);
}
