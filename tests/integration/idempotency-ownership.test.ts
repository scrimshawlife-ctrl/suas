import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../../src/db/transaction.js';
import { appendDomainEvent } from '../../src/events/index.js';
import { runIdempotentCommand } from '../../src/idempotency/run.js';
import {
  completeCommand,
  failCommand,
  lockCommandReservation,
  readCommandRecord,
  reserveCommand,
} from '../../src/idempotency/store.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';

const pool = createTestPool(8);
beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});
const input = () => ({
  tenantId: randomUUID(),
  commandScope: 'ownership-test',
  idempotencyKey: randomUUID(),
  requestFingerprint: 'same',
});

describe('idempotency reservation ownership', () => {
  it('rejects stale completion and failure without losing the replacement result', async () => {
    const request = input();
    const old = await reserveCommand(pool, request);
    await pool.query(
      "UPDATE command_idempotency_records SET updated_at = now() - interval '121 seconds' WHERE command_idempotency_id = $1",
      [old.record.commandIdempotencyId],
    );
    const replacement = await runIdempotentCommand(pool, request, () =>
      Promise.resolve({
        result: { winner: 'new' },
      }),
    );
    expect(replacement.record.attempts).toBe(2);
    expect(await lockCommandReservation(pool, old.record)).toBe(false);
    const aggregateId = randomUUID();
    await expect(
      withTransaction(pool, async (tx) => {
        await appendDomainEvent(tx, {
          tenantId: request.tenantId,
          eventType: 'CASE_CREATED',
          aggregateType: 'SupportCase',
          aggregateId,
          actorType: 'SYSTEM',
          actorId: 'audit',
          payload: {},
        });
        await completeCommand(tx, old.record.commandIdempotencyId, {
          expectedAttempts: old.record.attempts,
          result: { winner: 'old' },
        });
      }),
    ).rejects.toThrow('no longer owned');
    expect(
      (await pool.query('SELECT 1 FROM domain_events WHERE aggregate_id = $1', [aggregateId]))
        .rowCount,
    ).toBe(0);
    expect(
      await failCommand(pool, old.record.commandIdempotencyId, {
        expectedAttempts: old.record.attempts,
        error: 'late failure',
      }),
    ).toBeUndefined();
    const retried = await reserveCommand(pool, request);
    expect(retried.status).toBe('replay');
    expect(retried.record.result).toEqual({ winner: 'new' });
    expect(retried.record.attempts).toBe(2);
  });

  it('holds off a takeover while the domain transaction is still active', async () => {
    const request = input();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = runIdempotentCommand(pool, request, async (tx) => {
      await tx.query(
        "UPDATE command_idempotency_records SET updated_at = now() - interval '121 seconds' WHERE idempotency_key = $1",
        [request.idempotencyKey],
      );
      entered();
      await release;
      return { result: { winner: 'original' } };
    });
    void first.catch(() => undefined);
    let duplicate: ReturnType<typeof runIdempotentCommand> | undefined;
    const executeAgain = vi.fn(() => Promise.resolve({ result: { winner: 'duplicate' } }));
    try {
      await ready;
      duplicate = runIdempotentCommand(pool, request, executeAgain);
      void duplicate.catch(() => undefined);
      await vi.waitFor(async () => {
        expect(
          (
            await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%command_idempotency_records%'",
            )
          ).rowCount,
        ).toBeGreaterThan(0);
      });
      expect(executeAgain).not.toHaveBeenCalled();
    } finally {
      finish();
      await Promise.allSettled([first, ...(duplicate ? [duplicate] : [])]);
    }
    expect((await duplicate)?.replayed).toBe(true);
    expect(executeAgain).not.toHaveBeenCalled();
    expect((await readCommandRecord(pool, request))?.attempts).toBe(1);
  });
});
