/**
 * Persist the released qv-001 questionnaire so a Check-In can bind to it.
 *
 * Slice 12 scored from transcribed tables without a published row. The compute
 * job only runs for questionnaire_version `qv-001`, so LOCAL/TEST need that
 * version published (CHECKINS.md §5).
 */

import type { Pool } from 'pg';
import { createQuestionnaireVersion, publishQuestionnaireVersion } from './check-ins.js';
import { QV_001_QUESTIONS, QV_001_VERSION } from './sv-001.js';

export async function ensurePublishedQv001(pool: Pool, publishedBy: string): Promise<void> {
  const existing = await pool.query<{ status: string }>(
    `SELECT status FROM questionnaire_versions WHERE questionnaire_version = $1`,
    [QV_001_VERSION],
  );
  if (existing.rows[0] === undefined) {
    await createQuestionnaireVersion(pool, {
      questionnaireVersion: QV_001_VERSION,
      title: 'SUAS Check-In qv-001',
      questions: QV_001_QUESTIONS.map((question) => ({
        questionKey: question.questionKey,
        prompt: question.prompt,
        dimension: question.dimension,
        required: question.required,
        options: question.options.map((option) => ({
          optionKey: option.optionId,
          label: option.optionLabel,
        })),
      })),
    });
  }
  const status = existing.rows[0]?.status ?? 'DRAFT';
  if (status !== 'PUBLISHED') {
    await publishQuestionnaireVersion(pool, {
      questionnaireVersion: QV_001_VERSION,
      publishedBy,
    });
  }
}
