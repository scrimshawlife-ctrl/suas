/**
 * LOCAL demo smoke for the SUAS `/api/v0` surface.
 *
 * Run via `npm run smoke:demo` against the seeded demo Worker started by
 * `npm run dev:demo`. Use `npm run dev:demo -- --reset` for a pristine dataset.
 *
 * This script is LOCAL only:
 * - It calls `GET /api/v0/dev/last-challenge`, a dev-only helper that exists only
 *   on a LOCAL backend and 404s on staging.
 * - `assertLoopbackBaseUrl` refuses any non-loopback host, so this smoke can
 *   never be pointed at staging or production.
 *
 * Mutations per run are limited to one cancelled synthetic TRANSPORTATION
 * service request and one completed Check-In. All demo data is synthetic:
 * emails use @example.invalid, phone numbers use the 555-0100..555-0199 range,
 * and names are obviously fictional.
 */
import { pathToFileURL } from 'node:url';
import { DEMO_FIXED_CODE, DEMO_FIXED_CODE_DESTINATION } from '../src/auth/demo-fixed-code.js';

export type ApiResult = { status: number; json: unknown; text: string };

export type StepResult = { name: string; ok: boolean; detail: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

export function arr(obj: unknown, key: string): unknown[] | undefined {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return Array.isArray(value) ? value : undefined;
}

export class SmokeContext {
  readonly baseUrl: URL;
  readonly results: StepResult[] = [];
  token?: string;
  caseId?: string;
  private readonly log: (line: string) => void;
  private seq = 0;

  constructor(baseUrl: URL, log: (line: string) => void) {
    this.baseUrl = baseUrl;
    this.log = log;
  }

  async api(
    method: 'GET' | 'POST',
    path: string,
    opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<ApiResult> {
    const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method, headers };

    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body ?? {});
    }
    if (opts.token !== undefined) {
      headers.authorization = `Bearer ${opts.token}`;
    }
    if (opts.idempotencyKey !== undefined) {
      headers['idempotency-key'] = opts.idempotencyKey;
    }

    const response = await fetch(url, init);
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';

    let json: unknown = undefined;
    if (text.length > 0 && contentType.includes('json')) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = undefined;
      }
    }

    return { status: response.status, json, text };
  }

  key(): string {
    this.seq += 1;
    return `smoke-${Date.now()}-${this.seq}`;
  }

  async check(name: string, fn: () => Promise<string>): Promise<boolean> {
    try {
      const detail = await fn();
      this.results.push({ name, ok: true, detail });
      this.log(`PASS ${name} (${detail})`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.results.push({ name, ok: false, detail });
      this.log(`FAIL ${name}: ${detail}`);
      return false;
    }
  }

  skip(name: string): void {
    const detail = 'skipped: prerequisite failed';
    this.results.push({ name, ok: false, detail });
    this.log(`FAIL ${name}: ${detail}`);
  }

  expect(cond: boolean, message: string): asserts cond {
    if (!cond) {
      throw new Error(message);
    }
  }
}

const LOCAL_ONLY_NOTE =
  'This smoke only targets a LOCAL demo Worker and never staging or production.';

export function assertLoopbackBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid demo base URL "${raw}". ${LOCAL_ONLY_NOTE}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing protocol "${url.protocol}". ${LOCAL_ONLY_NOTE}`);
  }

  const host = url.hostname;
  const loopback =
    host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loopback) {
    throw new Error(`Refusing non-loopback host "${host}". ${LOCAL_ONLY_NOTE}`);
  }

  if (url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/$/, '');
  }

  return url;
}

export async function authAndCaseSteps(ctx: SmokeContext, email: string): Promise<void> {
  const requiredCategories = ['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'];

  let challengeCode: string | null = null;
  let openCaseId: string | null = null;
  let foodRequestId: string | null = null;
  let journeyId: string | null = null;

  const skipAll = (names: readonly string[]): void => {
    for (const name of names) {
      ctx.skip(name);
    }
  };

  // Step 1: the local Worker answers its health probe.
  await ctx.check('GET /health', async () => {
    const res = await ctx.api('GET', '/api/v0/health');
    ctx.expect(res.status === 200, `expected 200, got ${res.status}`);
    ctx.expect(str(res.json, 'status') === 'ok', 'expected json.status to be "ok"');
    return `status ${res.status}`;
  });

  // Step 2: request a one-time EMAIL_OTP challenge for the seeded demo veteran.
  const challenged = await ctx.check('POST /auth/challenges', async () => {
    const res = await ctx.api('POST', '/api/v0/auth/challenges', {
      body: { destination: email, method: 'EMAIL_OTP' },
    });
    ctx.expect(res.status === 202, `expected 202, got ${res.status}`);
    return `status ${res.status}`;
  });

  // Step 3: read the code back from the LOCAL-only dev helper (never logged).
  if (!challenged) {
    ctx.skip('GET /dev/last-challenge');
  } else {
    await ctx.check('GET /dev/last-challenge', async () => {
      const path = `/api/v0/dev/last-challenge?destination=${encodeURIComponent(email)}`;
      const res = await ctx.api('GET', path);
      ctx.expect(res.status === 200, `expected 200, got ${res.status}`);
      const code = str(res.json, 'code');
      ctx.expect(typeof code === 'string' && code.length > 0, 'expected a non-empty code string');
      if (email === DEMO_FIXED_CODE_DESTINATION) {
        // LOCAL demo: the Worker issues the fixed, memorable code to demo@example.invalid.
        ctx.expect(code === DEMO_FIXED_CODE, 'expected the fixed LOCAL demo code');
        challengeCode = DEMO_FIXED_CODE;
        return 'fixed LOCAL demo code issued';
      }
      challengeCode = code;
      return 'code retrieved (value not logged)';
    });
  }

  // Step 4: exchange the code for a session credential (kept as ctx.token).
  const code: string | null = challengeCode;
  if (code === null) {
    ctx.skip('POST /auth/challenges/commands/verify');
  } else {
    await ctx.check('POST /auth/challenges/commands/verify', async () => {
      const res = await ctx.api('POST', '/api/v0/auth/challenges/commands/verify', {
        body: { destination: email, code },
      });
      ctx.expect(res.status === 201, `expected 201, got ${res.status}`);
      const credential = str(res.json, 'session_credential');
      ctx.expect(
        typeof credential === 'string' && credential.length > 0,
        'expected a session credential',
      );
      ctx.token = credential;
      return `status ${res.status}, session established`;
    });
  }

  const token: string | undefined = ctx.token;
  if (token === undefined) {
    skipAll([
      'GET /veterans/me',
      'POST /cases (open, replay-safe)',
      'GET /cases/{caseId}/service-requests',
      'GET /service-requests/{id}',
      'POST /cases/{caseId}/service-requests (create, replay)',
      'POST /service-requests/{id}/commands/SUBMIT',
      'POST /service-requests/{id}/commands/CANCEL',
    ]);
    return;
  }

  // Step 5: the authenticated veteran profile exposes the seeded open case.
  await ctx.check('GET /veterans/me', async () => {
    const res = await ctx.api('GET', '/api/v0/veterans/me', { token });
    ctx.expect(res.status === 200, `expected 200, got ${res.status}`);
    const body: unknown = res.json;
    const openCase = isRecord(body) ? body.open_case : undefined;
    ctx.expect(isRecord(openCase), 'expected open_case to be an object');
    const caseId = str(openCase, 'case_id');
    ctx.expect(typeof caseId === 'string' && caseId.length > 0, 'expected open_case.case_id');
    const categories = arr(body, 'categories') ?? [];
    ctx.expect(categories.length >= 4, 'expected categories length >= 4');
    ctx.caseId = caseId;
    openCaseId = caseId;
    return `status ${res.status}, case ${caseId}, ${categories.length} categories`;
  });

  const caseId: string | null = openCaseId;
  if (caseId === null) {
    skipAll([
      'POST /cases (open, replay-safe)',
      'GET /cases/{caseId}/service-requests',
      'GET /service-requests/{id}',
      'POST /cases/{caseId}/service-requests (create, replay)',
      'POST /service-requests/{id}/commands/SUBMIT',
      'POST /service-requests/{id}/commands/CANCEL',
    ]);
    return;
  }

  // Step 6: opening the case is idempotent for a repeated key.
  const openKey = ctx.key();
  await ctx.check('POST /cases (open, replay-safe)', async () => {
    const first = await ctx.api('POST', '/api/v0/cases', {
      token,
      idempotencyKey: openKey,
      body: {},
    });
    ctx.expect(
      first.status === 200 || first.status === 201,
      `expected 200 or 201, got ${first.status}`,
    );
    const firstId = str(first.json, 'case_id');
    ctx.expect(firstId === caseId, `expected case_id ${String(caseId)}, got ${String(firstId)}`);
    const replay = await ctx.api('POST', '/api/v0/cases', {
      token,
      idempotencyKey: openKey,
      body: {},
    });
    ctx.expect(
      replay.status === 200 || replay.status === 201,
      `expected 200 or 201 on replay, got ${replay.status}`,
    );
    const replayId = str(replay.json, 'case_id');
    ctx.expect(
      replayId === caseId,
      `expected replay case_id ${String(caseId)}, got ${String(replayId)}`,
    );
    return `case ${String(caseId)} stable across replay`;
  });

  // Step 7: the seeded case covers every coordinated category.
  await ctx.check('GET /cases/{caseId}/service-requests', async () => {
    const res = await ctx.api('GET', `/api/v0/cases/${String(caseId)}/service-requests`, { token });
    ctx.expect(res.status === 200, `expected 200, got ${res.status}`);
    const list = arr(res.json, 'service_requests') ?? [];
    const categories = list
      .map((item) => str(item, 'category'))
      .filter((value): value is string => value !== undefined);
    for (const required of requiredCategories) {
      ctx.expect(categories.includes(required), `expected a ${required} service request`);
    }
    const food = list.find((item) => str(item, 'category') === 'FOOD');
    foodRequestId = food === undefined ? null : (str(food, 'service_request_id') ?? null);
    return `status ${res.status}, ${list.length} service requests`;
  });

  // Step 8: a single service request reads back with a status.
  const requestId: string | null = foodRequestId;
  if (requestId === null) {
    ctx.skip('GET /service-requests/{id}');
  } else {
    await ctx.check('GET /service-requests/{id}', async () => {
      const res = await ctx.api('GET', `/api/v0/service-requests/${String(requestId)}`, { token });
      ctx.expect(res.status === 200, `expected 200, got ${res.status}`);
      const status = str(res.json, 'status');
      ctx.expect(typeof status === 'string' && status.length > 0, 'expected a string status');
      return `status ${res.status}, state ${status}`;
    });
  }

  // Step 9: create a synthetic TRANSPORTATION request, submit it, then cancel it.
  const createKey = ctx.key();
  const transportBody = {
    category: 'TRANSPORTATION',
    details: { purpose: 'Smoke test ride (synthetic)' },
  };
  await ctx.check('POST /cases/{caseId}/service-requests (create, replay)', async () => {
    const created = await ctx.api('POST', `/api/v0/cases/${String(caseId)}/service-requests`, {
      token,
      idempotencyKey: createKey,
      body: transportBody,
    });
    ctx.expect(
      created.status === 200 || created.status === 201,
      `expected 200 or 201, got ${created.status}`,
    );
    const createdId = str(created.json, 'service_request_id');
    ctx.expect(
      typeof createdId === 'string' && createdId.length > 0,
      'expected service_request_id',
    );
    const replay = await ctx.api('POST', `/api/v0/cases/${String(caseId)}/service-requests`, {
      token,
      idempotencyKey: createKey,
      body: transportBody,
    });
    ctx.expect(
      replay.status === 200 || replay.status === 201,
      `expected 200 or 201 on replay, got ${replay.status}`,
    );
    const replayId = str(replay.json, 'service_request_id');
    ctx.expect(replayId === createdId, 'expected the replayed service_request_id to match');
    journeyId = createdId;
    return `service request ${createdId} stable across replay`;
  });

  const journeyRequestId: string | null = journeyId;
  if (journeyRequestId === null) {
    ctx.skip('POST /service-requests/{id}/commands/SUBMIT');
    ctx.skip('POST /service-requests/{id}/commands/CANCEL');
    return;
  }

  const submitted = await ctx.check('POST /service-requests/{id}/commands/SUBMIT', async () => {
    const res = await ctx.api(
      'POST',
      `/api/v0/service-requests/${String(journeyRequestId)}/commands/SUBMIT`,
      { token, idempotencyKey: ctx.key(), body: {} },
    );
    ctx.expect(res.status === 200, `expected 200, got ${res.status}`);
    ctx.expect(str(res.json, 'status') === 'SUBMITTED', 'expected status SUBMITTED');
    return 'status SUBMITTED';
  });

  if (!submitted) {
    ctx.skip('POST /service-requests/{id}/commands/CANCEL');
  } else {
    await ctx.check('POST /service-requests/{id}/commands/CANCEL', async () => {
      const res = await ctx.api(
        'POST',
        `/api/v0/service-requests/${String(journeyRequestId)}/commands/CANCEL`,
        {
          token,
          idempotencyKey: ctx.key(),
          body: { reason: 'Smoke test cleanup (synthetic).' },
        },
      );
      ctx.expect(res.status === 200, `expected 200, got ${res.status}`);
      ctx.expect(str(res.json, 'status') === 'CANCELLED', 'expected status CANCELLED');
      return 'status CANCELLED';
    });
  }
}

/**
 * Steps 10 to 18: resources (including cursor pagination), consents, notifications,
 * trusted contacts, follow-ups, the immediate-resources crisis read, the Check-In
 * journey, the web surface, and logout.
 *
 * Every call goes to the LOCAL seeded demo Worker. Steps that depend on a session
 * token or a case id are recorded as FAIL with 'skipped: prerequisite failed' when
 * the prerequisite from an earlier step is missing, so independent steps still run.
 */
export async function surfaceSteps(ctx: SmokeContext): Promise<void> {
  const withAuth = (
    method: 'GET' | 'POST',
    path: string,
    extra?: { body?: unknown; idempotencyKey?: string },
  ): Promise<ApiResult> => {
    const token = ctx.token;
    return token === undefined
      ? ctx.api(method, path, extra)
      : ctx.api(method, path, { ...extra, token });
  };

  // 10. Resources per category, then cursor pagination.
  await ctx.check('resources: one or more per category', async () => {
    const categories = ['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'];
    for (const category of categories) {
      const res = await withAuth('GET', `/api/v0/resources?category=${category}&limit=10`);
      ctx.expect(res.status === 200, `resources ${category} expected 200, got ${res.status}`);
      const resources = arr(res.json, 'resources');
      ctx.expect(
        resources !== undefined && resources.length >= 1,
        `resources ${category} expected at least one entry`,
      );
    }
    return `${categories.length} categories each with at least one resource`;
  });

  await ctx.check('resources: cursor pagination', async () => {
    const first = await withAuth('GET', '/api/v0/resources?category=FOOD&limit=1');
    ctx.expect(first.status === 200, `first page expected 200, got ${first.status}`);
    const firstPage = arr(first.json, 'resources');
    ctx.expect(
      firstPage !== undefined && firstPage.length === 1,
      'first page expected exactly one resource',
    );
    const firstId = str(firstPage[0], 'resource_id');
    ctx.expect(firstId !== undefined, 'first page resource missing resource_id');
    const nextCursor = str(first.json, 'next_cursor');
    ctx.expect(
      nextCursor !== undefined && nextCursor.length > 0,
      'first page missing a non-empty next_cursor',
    );
    const second = await withAuth(
      'GET',
      `/api/v0/resources?category=FOOD&limit=1&cursor=${encodeURIComponent(nextCursor)}`,
    );
    ctx.expect(second.status === 200, `second page expected 200, got ${second.status}`);
    const secondPage = arr(second.json, 'resources');
    ctx.expect(
      secondPage !== undefined && secondPage.length === 1,
      'second page expected exactly one resource',
    );
    const secondId = str(secondPage[0], 'resource_id');
    ctx.expect(
      secondId !== undefined && secondId !== firstId,
      'second page returned the same resource_id as the first page',
    );
    return `cursor page returned a different resource (${secondId})`;
  });

  // 11. Consents.
  await ctx.check('consents: at least one ACTIVE', async () => {
    const res = await withAuth('GET', '/api/v0/consents');
    ctx.expect(res.status === 200, `consents expected 200, got ${res.status}`);
    const consents = arr(res.json, 'consents');
    ctx.expect(consents !== undefined, 'consents response missing consents array');
    const active = consents.filter((consent) => str(consent, 'status') === 'ACTIVE');
    ctx.expect(active.length >= 1, 'expected at least one consent with status ACTIVE');
    return `${active.length} ACTIVE consent(s)`;
  });

  // 12. Notifications.
  await ctx.check('notifications: list', async () => {
    const res = await withAuth('GET', '/api/v0/notifications');
    ctx.expect(res.status === 200, `notifications expected 200, got ${res.status}`);
    const notifications = arr(res.json, 'notifications');
    ctx.expect(notifications !== undefined, 'notifications response missing notifications array');
    return `${notifications.length} notification(s)`;
  });

  // 13. Trusted contacts.
  await ctx.check('trusted-contacts: at least one', async () => {
    const res = await withAuth('GET', '/api/v0/trusted-contacts');
    ctx.expect(res.status === 200, `trusted-contacts expected 200, got ${res.status}`);
    const contacts = arr(res.json, 'trusted_contacts');
    ctx.expect(
      contacts !== undefined && contacts.length >= 1,
      'expected at least one trusted contact',
    );
    return `${contacts.length} trusted contact(s)`;
  });

  // 14. Follow-ups for the case opened in the earlier steps.
  if (ctx.caseId === undefined) {
    ctx.skip('follow-ups: at least one');
  } else {
    const caseId = ctx.caseId;
    await ctx.check('follow-ups: at least one', async () => {
      const res = await withAuth('GET', `/api/v0/cases/${encodeURIComponent(caseId)}/follow-ups`);
      ctx.expect(res.status === 200, `follow-ups expected 200, got ${res.status}`);
      const followUps = arr(res.json, 'follow_ups');
      ctx.expect(
        followUps !== undefined && followUps.length >= 1,
        'expected at least one follow-up',
      );
      return `${followUps.length} follow-up(s)`;
    });
  }

  // 15. Immediate resources (the crisis read).
  await ctx.check('immediate-resources: crisis read', async () => {
    const res = await withAuth('GET', '/api/v0/immediate-resources');
    ctx.expect(res.status === 200, `immediate-resources expected 200, got ${res.status}`);
    const state = str(res.json, 'state');
    ctx.expect(state !== undefined, 'immediate-resources response missing a string state');
    return `state ${state}`;
  });

  // 16. Check-In journey.
  if (ctx.token === undefined) {
    ctx.skip('check-ins: create, respond, complete');
  } else {
    await ctx.check('check-ins: create, respond, complete', async () => {
      const created = await withAuth('POST', '/api/v0/check-ins');
      ctx.expect(created.status === 201, `POST /check-ins expected 201, got ${created.status}`);
      const checkInId = str(created.json, 'check_in_id');
      ctx.expect(checkInId !== undefined, 'POST /check-ins missing check_in_id');
      const questions = arr(created.json, 'questions');
      ctx.expect(
        questions !== undefined && questions.length >= 1,
        'POST /check-ins missing a non-empty questions array',
      );
      const base = `/api/v0/check-ins/${encodeURIComponent(checkInId)}`;
      for (const question of questions) {
        const questionId = str(question, 'question_id');
        ctx.expect(questionId !== undefined, 'check-in question missing question_id');
        const options = arr(question, 'options');
        ctx.expect(
          options !== undefined && options.length >= 1,
          `check-in question ${questionId} missing options`,
        );
        const answerOptionId = str(options[0], 'answer_option_id');
        ctx.expect(
          answerOptionId !== undefined,
          `check-in question ${questionId} option missing answer_option_id`,
        );
        const response = await withAuth('POST', `${base}/responses`, {
          body: { question_id: questionId, answer_option_id: answerOptionId },
        });
        ctx.expect(
          response.status === 200,
          `check-in response for ${questionId} expected 200, got ${response.status}`,
        );
      }
      const completed = await withAuth('POST', `${base}/commands/complete`);
      ctx.expect(
        completed.status === 200,
        `check-in complete expected 200, got ${completed.status}`,
      );
      ctx.expect(
        str(completed.json, 'status') === 'COMPLETED',
        `check-in complete expected status COMPLETED, got ${str(completed.json, 'status') ?? 'none'}`,
      );
      const fetched = await withAuth('GET', base);
      ctx.expect(fetched.status === 200, `GET check-in expected 200, got ${fetched.status}`);
      ctx.expect(
        str(fetched.json, 'status') === 'COMPLETED',
        `GET check-in expected status COMPLETED, got ${str(fetched.json, 'status') ?? 'none'}`,
      );
      return `check-in ${checkInId} completed after ${questions.length} response(s)`;
    });
  }

  // 17. Web surface (not under /api/v0, no cookie).
  await ctx.check('web: /app and /app/chat', async () => {
    const app = await ctx.api('GET', '/app');
    ctx.expect(app.status < 500, `GET /app expected status < 500, got ${app.status}`);
    ctx.expect(app.text.toLowerCase().includes('<html'), 'GET /app body did not contain <html');
    const chat = await ctx.api('GET', '/app/chat');
    ctx.expect(chat.status < 500, `GET /app/chat expected status < 500, got ${chat.status}`);
    return `/app ${app.status}, /app/chat ${chat.status}`;
  });

  // 18. Logout invalidates the session.
  if (ctx.token === undefined) {
    ctx.skip('auth: logout invalidates the session');
  } else {
    await ctx.check('auth: logout invalidates the session', async () => {
      const logout = await withAuth('POST', '/api/v0/auth/sessions/commands/logout');
      ctx.expect(logout.status === 204, `logout expected 204, got ${logout.status}`);
      const me = await withAuth('GET', '/api/v0/veterans/me');
      ctx.expect(me.status === 401, `GET /veterans/me after logout expected 401, got ${me.status}`);
      return 'logout returned 204 and the session credential was rejected';
    });
  }
}

/**
 * Runs the full LOCAL demo smoke: authenticate and open a case (steps 1 to 9),
 * then the remaining surface steps (10 to 18). Returns the tallies plus every
 * recorded step result.
 */
export async function runSmoke(
  baseUrl: URL,
  opts: { email: string; log: (line: string) => void },
): Promise<{
  passed: number;
  failed: number;
  results: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const ctx = new SmokeContext(baseUrl, opts.log);
  await authAndCaseSteps(ctx, opts.email);
  await surfaceSteps(ctx);
  const passed = ctx.results.filter((result) => result.ok).length;
  const failed = ctx.results.length - passed;
  const results = ctx.results.map((result) => ({
    name: result.name,
    ok: result.ok,
    detail: result.detail,
  }));
  return { passed, failed, results };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  try {
    const baseUrl = assertLoopbackBaseUrl(
      process.argv[2] ?? process.env.SUAS_DEMO_BASE_URL ?? 'http://127.0.0.1:3000',
    );
    const email = process.env.SUAS_DEMO_VETERAN_EMAIL ?? DEMO_FIXED_CODE_DESTINATION;
    const summary = await runSmoke(baseUrl, { email, log });
    log(`smoke: ${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    log(`smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
