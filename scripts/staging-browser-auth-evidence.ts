import { createHash } from 'node:crypto';

const DEFAULT_RESEND_API = 'https://api.resend.com';
const DELIVERY_WAIT_MS = 30_000;
const DELIVERY_POLL_MS = 1_000;

type EmailSummary = {
  id: string;
  to: string[];
  subject: string;
  status?: string;
  last_event?: string;
  created_at: string;
};

type Evidence = {
  status: 'ok';
  hosts: Array<{
    origin: string;
    root_status: number;
    root_location: string | null;
    join_status: number;
    protected_api_status: number;
    browser_cookie_api_status: number;
    cross_origin_write_status: number;
  }>;
  challenge: {
    approved_status: number;
    unknown_status: number;
    normalized_public_response_match: boolean;
  };
  resend: {
    request_observed: boolean;
    delivery_status: string;
    unknown_message_count: number;
  };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function origin(name: string): string {
  const value = required(name);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTPS origin without a path, query, or fragment.`);
  }
  return parsed.origin;
}

function firstApprovedEmail(): string {
  const value = required('SUAS_STAGING_AUTH_EMAILS')
    .split(',')
    .map((item) => item.trim())
    .find(Boolean);
  if (!value) throw new Error('SUAS_STAGING_AUTH_EMAILS must contain at least one address.');
  return value;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
}

async function inspectHost(base: string): Promise<Evidence['hosts'][number]> {
  const root = await request(`${base}/`);
  const join = await request(`${base}/app/join?role=veteran`);
  const joinBody = await join.text();
  if (!joinBody.includes('action="/app/auth/challenges"') || !joinBody.includes('type="email"')) {
    throw new Error(`${base} did not render the released EMAIL OTP enrollment form.`);
  }

  const protectedApi = await request(`${base}/api/v0/veterans/me`);
  const browserCookieApi = await request(`${base}/api/v0/veterans/me`, {
    headers: { cookie: '__Secure-suas_session=synthetic-invalid-evidence-value' },
  });
  const crossOriginWrite = await request(`${base}/app/qrf/deploy`, {
    method: 'POST',
    headers: {
      cookie: '__Secure-suas_session=synthetic-invalid-evidence-value',
      origin: 'https://cross-origin.invalid',
      'sec-fetch-site': 'cross-site',
    },
  });

  return {
    origin: base,
    root_status: root.status,
    root_location: root.headers.get('location'),
    join_status: join.status,
    protected_api_status: protectedApi.status,
    browser_cookie_api_status: browserCookieApi.status,
    cross_origin_write_status: crossOriginWrite.status,
  };
}

function normalizedPublicResponse(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<input\b[^>]*\bvalue="[^"]*"[^>]*>/gi, '<input value="[REDACTED]">')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function submitChallenge(base: string, destination: string): Promise<Response> {
  return request(`${base}/app/auth/challenges`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ role: 'veteran', destination }),
  });
}

async function listEmails(apiKey: string): Promise<EmailSummary[]> {
  const api = process.env.RESEND_API_BASE_URL?.trim() || DEFAULT_RESEND_API;
  const response = await request(`${api}/emails?limit=100`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `Resend metadata query failed with status ${response.status}. Use a separately authorized read-capable RESEND_AUDIT_API_KEY; do not broaden or expose the Worker sending credential.`,
    );
  }
  const payload = (await response.json()) as { data?: EmailSummary[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

async function waitForDelivery(
  apiKey: string,
  baselineIds: Set<string>,
  approvedEmail: string,
): Promise<EmailSummary> {
  const deadline = Date.now() + DELIVERY_WAIT_MS;
  while (Date.now() < deadline) {
    const found = (await listEmails(apiKey)).find(
      (email) =>
        !baselineIds.has(email.id) &&
        email.to.map((address) => address.toLowerCase()).includes(approvedEmail.toLowerCase()) &&
        email.subject === 'SUAS sign-in code',
    );
    if (found) {
      const status = deliveryStatus(found);
      if (['bounced', 'canceled', 'complained', 'failed', 'suppressed'].includes(status)) {
        throw new Error(`Resend reported a failed delivery lifecycle state: ${status}.`);
      }
      if (['delivered', 'queued', 'sent'].includes(status)) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_MS));
  }
  throw new Error(
    'No accepted, sent, or delivered SUAS sign-in metadata appeared before the timeout.',
  );
}

function deliveryStatus(email: EmailSummary): string {
  return (email.status ?? email.last_event ?? 'unknown').toLowerCase();
}

function assertHost(result: Evidence['hosts'][number]): void {
  if (result.root_status !== 302 || result.root_location !== '/app') {
    throw new Error(`${result.origin} root did not redirect to /app.`);
  }
  if (result.join_status !== 200)
    throw new Error(`${result.origin} enrollment did not return 200.`);
  if (result.protected_api_status !== 401 || result.browser_cookie_api_status !== 401) {
    throw new Error(`${result.origin} protected API did not remain bearer-only.`);
  }
  if (result.cross_origin_write_status !== 401) {
    throw new Error(`${result.origin} cross-origin browser write did not fail closed.`);
  }
}

async function main(): Promise<void> {
  const workerOrigin = origin('SUAS_E2E_BASE_URL');
  const canonicalOrigin = origin('SUAS_CANONICAL_BASE_URL');
  const approvedEmail = firstApprovedEmail();
  const auditKey = required('RESEND_AUDIT_API_KEY');

  const hosts = await Promise.all([inspectHost(workerOrigin), inspectHost(canonicalOrigin)]);
  hosts.forEach(assertHost);

  const before = await listEmails(auditKey);
  const baselineIds = new Set(before.map((email) => email.id));

  const approved = await submitChallenge(workerOrigin, approvedEmail);
  const approvedBody = await approved.text();
  if (approved.status !== 200) throw new Error('Approved challenge request did not return 200.');

  const delivered = await waitForDelivery(auditKey, baselineIds, approvedEmail);
  const afterApprovedIds = new Set((await listEmails(auditKey)).map((email) => email.id));

  const unknownAddress = `unknown-${Date.now()}@example.invalid`;
  const unknown = await submitChallenge(canonicalOrigin, unknownAddress);
  const unknownBody = await unknown.text();
  if (unknown.status !== 200) throw new Error('Unknown challenge request did not return 200.');

  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const afterUnknown = await listEmails(auditKey);
  const unknownMessages = afterUnknown.filter(
    (email) =>
      !afterApprovedIds.has(email.id) &&
      email.to.map((address) => address.toLowerCase()).includes(unknownAddress.toLowerCase()),
  );

  const responsesMatch =
    digest(normalizedPublicResponse(approvedBody)) ===
    digest(normalizedPublicResponse(unknownBody));
  if (!responsesMatch)
    throw new Error('Approved and unknown challenges exposed different public responses.');
  if (unknownMessages.length !== 0)
    throw new Error('Unknown challenge produced provider delivery metadata.');

  const evidence: Evidence = {
    status: 'ok',
    hosts,
    challenge: {
      approved_status: approved.status,
      unknown_status: unknown.status,
      normalized_public_response_match: responsesMatch,
    },
    resend: {
      request_observed: true,
      delivery_status: deliveryStatus(delivered),
      unknown_message_count: unknownMessages.length,
    },
  };
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown staging auth evidence failure.');
  process.exitCode = 1;
});
