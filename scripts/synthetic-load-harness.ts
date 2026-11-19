/**
 * Synthetic load harness — measures against a local comparison input without
 * claiming SLO compliance: D-021 and D-023 are DECISION_PENDING.
 *
 * Drives concurrent authenticated GET /api/v0/resources against a startApp instance
 * as a self-attested Veteran (the R9.1 request gate refuses an unverified one).
 * Prints p50/p95 latency and exits non-zero when any sample fails.
 */

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startApp } from '../src/app.js';
import { createSession } from '../src/auth/index.js';
import { createUser } from '../src/identity/index.js';
import { syntheticEmail } from '../src/testing/fixture-boundary.js';
import { PILOT_PERFORMANCE_SLOS } from '../src/resilience/index.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../tests/helpers/env.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

/**
 * Latency summary for one run. A run with a failed or missing sample is never within
 * target: the target is for successful reads, so failures would flatter the p95.
 */
export function summarizeLoad(samples: readonly number[], failures: number, targetP95Ms: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  return {
    samples: sorted.length,
    failures,
    p50_ms: Number(percentile(sorted, 50).toFixed(2)),
    p95_ms: Number(p95.toFixed(2)),
    max_ms: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
    observed_p95_within_target: failures === 0 && sorted.length > 0 && p95 <= targetP95Ms,
  };
}

async function main(): Promise<void> {
  const concurrency = Number(process.env.SUAS_LOAD_CONCURRENCY ?? 20);
  const iterations = Number(process.env.SUAS_LOAD_ITERATIONS ?? 100);
  const app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_SESSION_SECRET: TEST_SESSION_SECRET,
    }),
    listen: false,
  });
  try {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`load-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    const headers = { authorization: `Bearer ${session.credential}` };

    // D-016 self-attestation through the public route, as a real Veteran opens the gate.
    const attested = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/commands/self-attest',
      headers: { ...headers, 'idempotency-key': `load-${randomUUID()}` },
      payload: {},
    });
    if (attested.statusCode !== 200) {
      throw new Error(`self-attestation expected 200, got ${attested.statusCode}`);
    }

    const samples: number[] = [];
    let failures = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      for (let i = 0; i < Math.ceil(iterations / concurrency); i += 1) {
        const started = performance.now();
        const response = await app.server.inject({
          method: 'GET',
          url: '/api/v0/resources?limit=20',
          headers,
        });
        samples.push(performance.now() - started);
        if (response.statusCode !== 200) failures += 1;
      }
    });
    await Promise.all(workers);
    const { observed_p95_within_target, ...summary } = summarizeLoad(
      samples,
      failures,
      PILOT_PERFORMANCE_SLOS.successfulReadP95Ms,
    );
    console.log(
      JSON.stringify(
        {
          concurrency,
          ...summary,
          comparison_target: {
            successful_read_p95_ms: PILOT_PERFORMANCE_SLOS.successfulReadP95Ms,
            observed_p95_within_target,
          },
          slo_verdict: 'NOT_COMPUTABLE',
          note: 'The read target is a local comparison input; D-023 and D-021 are DECISION_PENDING, so this local run cannot establish SLO or sustained-load compliance.',
        },
        null,
        2,
      ),
    );
    if (failures > 0) {
      console.error(`load: ${failures} of ${samples.length} samples failed`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
