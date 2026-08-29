/**
 * Synthetic load harness — measures against an approved pilot comparison target
 * without claiming SLO compliance, because D-021 has no workload magnitude.
 *
 * Drives concurrent authenticated GET /api/v0/health and /api/v0/resources
 * against a running startApp instance. Prints p50/p95 latency only.
 */

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
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
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify(
        {
          concurrency,
          samples: samples.length,
          failures,
          p50_ms: Number(percentile(samples, 50).toFixed(2)),
          p95_ms: Number(percentile(samples, 95).toFixed(2)),
          max_ms: Number((samples[samples.length - 1] ?? 0).toFixed(2)),
          comparison_target: {
            successful_read_p95_ms: PILOT_PERFORMANCE_SLOS.successfulReadP95Ms,
            observed_p95_within_target:
              percentile(samples, 95) <= PILOT_PERFORMANCE_SLOS.successfulReadP95Ms,
          },
          slo_verdict: 'NOT_COMPUTABLE',
          note: 'D-023 read target is approved for pilot comparison. D-021 workload magnitude is not released, so this local run cannot establish sustained-load compliance.',
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
