/**
 * HTTP adapter for the VA Veteran Confirmation API (`POST {base}/status`, `apikey` header).
 *
 * suas-specs #72 R9.1 (proposal) and D035_VA_CONFIRMATION_ADAPTER.md §4 (HTTP contract),
 * §6 (secret), §10–§11 (normalization and failure classes), §13 (telemetry). Provider
 * payloads stay here: callers get only a `VeteranConfirmationResult`. Logs carry no
 * projection value, key or body, and the adapter never throws for a provider failure.
 */

import { fetchWithTimeout } from '../resilience/outbound-fetch.js';
import {
  VA_CONFIRMATION_CONTRACT_VERSION,
  VA_CONFIRMATION_PROJECTION_ID,
  vaConfirmationProjectionSchema,
  type VaConfirmationFailureClass,
  type VaConfirmationProjection,
  type VaProviderEnvironment,
  type VeteranConfirmationPort,
  type VeteranConfirmationResult,
} from './va-confirmation.js';
import { normalizeVaVeteranStatus } from './veteran-verification.js';

export const VA_CONFIRMATION_HTTP_IMPLEMENTATION = 'va-confirmation-http' as const;

export interface FetchTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

const defaultTransport: FetchTransport = {
  fetch: (url, init) => fetchWithTimeout(url, init),
};

/** D035 §13 allowed telemetry only. */
export interface VaConfirmationLogRecord {
  readonly adapter: typeof VA_CONFIRMATION_HTTP_IMPLEMENTATION;
  readonly adapter_version: typeof VA_CONFIRMATION_CONTRACT_VERSION;
  readonly provider_environment: VaProviderEnvironment;
  readonly projection_id: typeof VA_CONFIRMATION_PROJECTION_ID;
  readonly normalized_status: VeteranConfirmationResult['status'];
  readonly failure_class: VaConfirmationFailureClass | null;
  readonly latency_bucket: string;
}

export type VaConfirmationLogger = (record: VaConfirmationLogRecord) => void;

export class VaConfirmationMisconfiguredError extends Error {
  readonly code = 'CONFIGURATION_INVALID';

  constructor(detail: string) {
    super(`VA confirmation adapter is misconfigured: ${detail}.`);
    this.name = 'VaConfirmationMisconfiguredError';
  }
}

export interface VaConfirmationHttpOptions {
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly environment: Exclude<VaProviderEnvironment, 'NONE'>;
  readonly transport?: FetchTransport;
  readonly logger?: VaConfirmationLogger;
}

/** Fails closed before any provider call when the key or base URL is absent (D035 §6). */
export function createVaConfirmationHttpAdapter(
  options: VaConfirmationHttpOptions,
): VaConfirmationHttpAdapter {
  if (options.apiKey === undefined || options.apiKey.trim() === '') {
    throw new VaConfirmationMisconfiguredError('SUAS_VA_CONFIRMATION_API_KEY is absent');
  }
  if (options.baseUrl === undefined || !options.baseUrl.startsWith('https://')) {
    throw new VaConfirmationMisconfiguredError('SUAS_VA_CONFIRMATION_BASE_URL is not HTTPS');
  }
  return new VaConfirmationHttpAdapter(options.baseUrl, options.apiKey, options);
}

export class VaConfirmationHttpAdapter implements VeteranConfirmationPort {
  readonly implementation = VA_CONFIRMATION_HTTP_IMPLEMENTATION;
  readonly providerEnvironment: Exclude<VaProviderEnvironment, 'NONE'>;

  private readonly transport: FetchTransport;
  private readonly logger: VaConfirmationLogger | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    options: Pick<VaConfirmationHttpOptions, 'environment' | 'transport' | 'logger'>,
  ) {
    this.providerEnvironment = options.environment;
    this.transport = options.transport ?? defaultTransport;
    this.logger = options.logger;
  }

  async confirm(projection: VaConfirmationProjection): Promise<VeteranConfirmationResult> {
    const started = Date.now();
    const result = await this.query(projection);
    this.logger?.({
      adapter: VA_CONFIRMATION_HTTP_IMPLEMENTATION,
      adapter_version: VA_CONFIRMATION_CONTRACT_VERSION,
      provider_environment: this.providerEnvironment,
      projection_id: VA_CONFIRMATION_PROJECTION_ID,
      normalized_status: result.status,
      failure_class: result.failureClass ?? null,
      latency_bucket: latencyBucket(Date.now() - started),
    });
    return result;
  }

  private async query(projection: VaConfirmationProjection): Promise<VeteranConfirmationResult> {
    // Only released projection fields are sent; anything else is refused first (§14 5–6).
    const parsed = vaConfirmationProjectionSchema.safeParse(projection);
    if (!parsed.success) return unavailable('REQUEST_INVALID');
    const p = parsed.data;
    const body = JSON.stringify({
      firstName: p.firstName,
      lastName: p.lastName,
      birthDate: p.birthDate,
      streetAddressLine1: p.streetAddressLine1,
      city: p.city,
      state: p.state,
      country: p.country,
      zipCode: p.zipCode,
    });

    let response: Response;
    try {
      response = await this.transport.fetch(`${this.baseUrl}/status`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          apikey: this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      });
    } catch (error: unknown) {
      return unavailable(isTimeoutError(error) ? 'TIMEOUT' : 'NETWORK_ERROR');
    }

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return fromErrorStatus(response.status);
    }
    // Bounded checks before parsing (D035 §4 rule 6).
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return unavailable('PROVIDER_RESPONSE_INVALID');
    }
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (text === undefined) return unavailable('PROVIDER_RESPONSE_INVALID');
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return unavailable('PROVIDER_RESPONSE_INVALID');
    }
    return fromStatusBody(payload);
  }
}

/** R9.1 D9: the adapter reads at most this much response body; more is UNAVAILABLE. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** The body as UTF-8, or undefined once it passes `limit` bytes (the rest is cancelled). */
async function readBoundedText(response: Response, limit: number): Promise<string | undefined> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function unavailable(failureClass: VaConfirmationFailureClass): VeteranConfirmationResult {
  return { status: 'UNAVAILABLE', failureClass };
}

/**
 * Every error status is UNAVAILABLE, never a more definite answer (D035 §10-§11; owner M2).
 * A 400 is REQUEST_INVALID, which the person may correct and retry; 404 and anything
 * unlisted are PROVIDER_RESPONSE_INVALID.
 */
function fromErrorStatus(status: number): VeteranConfirmationResult {
  if (status === 400 || status === 413 || status === 415) return unavailable('REQUEST_INVALID');
  if (status === 401 || status === 403) return unavailable('AUTHENTICATION_REJECTED');
  if (status === 429) return unavailable('PROVIDER_RATE_LIMITED');
  if (status >= 500 && status <= 599) return unavailable('PROVIDER_UNAVAILABLE');
  return unavailable('PROVIDER_RESPONSE_INVALID');
}

/** D035 §10. The deprecated `id` and any other field are ignored and never kept. */
function fromStatusBody(payload: unknown): VeteranConfirmationResult {
  if (typeof payload !== 'object' || payload === null) {
    return unavailable('PROVIDER_RESPONSE_INVALID');
  }
  const record = payload as { veteran_status?: unknown; not_confirmed_reason?: unknown };
  const status = record.veteran_status;
  if (status === 'confirmed') return { status: 'VERIFIED' };
  // The VA document writes both spellings.
  if (status !== 'not confirmed' && status !== 'not_confirmed') {
    return unavailable('PROVIDER_RESPONSE_INVALID');
  }
  const normalized = normalizeVaVeteranStatus({
    veteranStatus: 'not confirmed',
    notConfirmedReason: record.not_confirmed_reason,
    sourceContractVersion: VA_CONFIRMATION_CONTRACT_VERSION,
  });
  if (normalized.status === 'UNAVAILABLE') {
    return normalized.notConfirmedReason === 'ERROR'
      ? { status: 'UNAVAILABLE', notConfirmedReason: 'ERROR', failureClass: 'PROVIDER_UNAVAILABLE' }
      : unavailable('PROVIDER_REASON_UNKNOWN');
  }
  return {
    status: normalized.status,
    ...(normalized.notConfirmedReason !== undefined
      ? { notConfirmedReason: normalized.notConfirmedReason }
      : {}),
  };
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function latencyBucket(ms: number): string {
  if (ms < 1000) return 'lt_1s';
  if (ms < 3000) return '1s_3s';
  if (ms < 10_000) return '3s_10s';
  return 'gte_10s';
}
