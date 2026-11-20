/**
 * Config selection and guards for the AWS-backed capability ports
 * (V1_PROJECT_PLAN.md §4.1, §7; ENVIRONMENT.md §3 rules 3-4, §5).
 */

import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

function issuesFor(env: Record<string, string | undefined>): string {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

const staging = (overrides: Record<string, string | undefined>) =>
  validEnv({ SUAS_ENV: 'STAGING', ...overrides });

describe('AWS capability config defaults', () => {
  it('leaves every new capability disabled when nothing is set', () => {
    const config = loadConfig(validEnv());
    expect(config.modelInference).toEqual({
      mode: 'disabled',
      bedrockModelId: undefined,
      relayFunction: undefined,
      guardrailId: undefined,
      guardrailVersion: undefined,
    });
    expect(config.objectStorage).toEqual({ mode: 'disabled', bucket: undefined });
    expect(config.idVerification.mode).toBe('disabled');
    expect(config.aws.region).toBeUndefined();
  });

  it('rejects an unknown mode value', () => {
    expect(issuesFor(validEnv({ SUAS_MODEL_INFERENCE_MODE: 'openai' }))).toContain(
      'SUAS_MODEL_INFERENCE_MODE="openai"',
    );
  });

  it('describes modes without secrets or identifiers', () => {
    const described = describeConfig(
      loadConfig(
        validEnv({
          SUAS_ENV: 'LOCAL',
          SUAS_MODEL_INFERENCE_MODE: 'fake',
          SUAS_BEDROCK_MODEL_ID: 'secret-id',
        }),
      ),
    );
    expect(described.model_inference_mode).toBe('fake');
    expect(JSON.stringify(described)).not.toContain('secret-id');
  });
});

describe('real AWS modes', () => {
  it('accepts S3 in STAGING with its configuration', () => {
    const config = loadConfig(
      staging({
        SUAS_AWS_REGION: 'us-west-2',
        SUAS_OBJECT_STORAGE_MODE: 's3',
        SUAS_S3_BUCKET: 'suas-staging-assets',
      }),
    );
    expect(config.aws.region).toBe('us-west-2');
    expect(config.modelInference.mode).toBe('disabled');
    expect(config.objectStorage.bucket).toBe('suas-staging-assets');
  });

  // R17.1, R17.3, R17.7 (contributor proposal, not released): STAGING may use bedrock only
  // through the relay with a guardrail; fake stays out of STAGING; PRODUCTION allows disabled.
  const stagingBedrock = {
    SUAS_MODEL_INFERENCE_MODE: 'bedrock',
    SUAS_AWS_REGION: 'us-east-2',
    SUAS_BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    SUAS_MODEL_INFERENCE_RELAY_FUNCTION: 'Suas-Staging-Backend-InferenceRelay',
    SUAS_BEDROCK_GUARDRAIL_ID: 'abc123def456',
    SUAS_BEDROCK_GUARDRAIL_VERSION: '1',
  };

  it('accepts bedrock in STAGING through the relay with model and guardrail', () => {
    const config = loadConfig(staging(stagingBedrock));
    expect(config.modelInference).toEqual({
      mode: 'bedrock',
      bedrockModelId: stagingBedrock.SUAS_BEDROCK_MODEL_ID,
      relayFunction: stagingBedrock.SUAS_MODEL_INFERENCE_RELAY_FUNCTION,
      guardrailId: 'abc123def456',
      guardrailVersion: '1',
    });
  });

  it.each([
    'SUAS_MODEL_INFERENCE_RELAY_FUNCTION',
    'SUAS_BEDROCK_MODEL_ID',
    'SUAS_BEDROCK_GUARDRAIL_ID',
    'SUAS_BEDROCK_GUARDRAIL_VERSION',
  ])('refuses STAGING bedrock without %s', (missing) => {
    const issues = issuesFor(staging({ ...stagingBedrock, [missing]: undefined }));
    expect(issues).toContain('SUAS_MODEL_INFERENCE_MODE=bedrock in STAGING requires');
    expect(issues).toContain(missing);
  });

  it('refuses STAGING bedrock without its region', () => {
    expect(issuesFor(staging({ ...stagingBedrock, SUAS_AWS_REGION: undefined }))).toContain(
      'SUAS_AWS_REGION is required',
    );
  });

  it('refuses the fake model in STAGING', () => {
    expect(issuesFor(staging({ SUAS_MODEL_INFERENCE_MODE: 'fake' }))).toContain(
      'SUAS_MODEL_INFERENCE_MODE=fake is forbidden in STAGING',
    );
  });

  it.each(['bedrock', 'fake'])('refuses model inference in PRODUCTION (mode %s)', (mode) => {
    expect(
      issuesFor(
        validEnv({ ...stagingBedrock, SUAS_ENV: 'PRODUCTION', SUAS_MODEL_INFERENCE_MODE: mode }),
      ),
    ).toContain(`SUAS_MODEL_INFERENCE_MODE=${mode} is forbidden in PRODUCTION`);
  });

  it('refuses a relay function or guardrail without bedrock, and malformed values', () => {
    const issues = issuesFor(
      staging({
        SUAS_AWS_REGION: 'us-east-2',
        SUAS_MODEL_INFERENCE_RELAY_FUNCTION: 'not a function',
        SUAS_BEDROCK_GUARDRAIL_ID: 'Bad Id',
        SUAS_BEDROCK_GUARDRAIL_VERSION: '0',
      }),
    );
    expect(issues).toContain('SUAS_MODEL_INFERENCE_RELAY_FUNCTION is allowed only with');
    expect(issues).toContain('must be a Lambda function name or ARN');
    expect(issues).toContain(
      'SUAS_BEDROCK_GUARDRAIL_ID and _VERSION are allowed only with bedrock',
    );
    expect(issues).toContain('must be a Bedrock guardrail id or ARN');
    expect(issues).toContain('must be a guardrail version number or DRAFT');
  });

  it.each([
    ['SUAS_MODEL_INFERENCE_MODE', 'bedrock'],
    ['SUAS_OBJECT_STORAGE_MODE', 's3'],
  ])('refuses %s=%s in LOCAL and TEST', (varName, value) => {
    const extra = {
      [varName]: value,
      SUAS_AWS_REGION: 'us-west-2',
      SUAS_S3_BUCKET: 'suas-assets',
    };
    expect(issuesFor(validEnv(extra))).toContain(`${varName}=${value} is forbidden in TEST`);
    expect(issuesFor(validEnv({ ...extra, SUAS_ENV: 'LOCAL' }))).toContain('forbidden in LOCAL');
  });

  it('requires the region and bucket their mode needs', () => {
    const issues = issuesFor(staging({ SUAS_OBJECT_STORAGE_MODE: 's3' }));
    expect(issues).toContain('SUAS_AWS_REGION is required');
    expect(issues).toContain('SUAS_S3_BUCKET is required');
  });

  it('rejects a malformed region and bucket name', () => {
    const issues = issuesFor(staging({ SUAS_AWS_REGION: 'west', SUAS_S3_BUCKET: 'Bad_Bucket' }));
    expect(issues).toContain('SUAS_AWS_REGION must be an AWS region name');
    expect(issues).toContain('SUAS_S3_BUCKET must be a valid S3 bucket name');
  });
});

describe('fake modes in PRODUCTION (plan §7)', () => {
  // PRODUCTION is also rejected wholesale until SPEC-018; these assert the fake
  // refusal is reported in its own right so it survives that gate being lifted.
  it.each(['SUAS_ID_VERIFICATION_MODE', 'SUAS_MODEL_INFERENCE_MODE', 'SUAS_OBJECT_STORAGE_MODE'])(
    'refuses %s=fake',
    (varName) => {
      expect(issuesFor(validEnv({ SUAS_ENV: 'PRODUCTION', [varName]: 'fake' }))).toContain(
        `${varName}=fake is forbidden in PRODUCTION`,
      );
    },
  );

  it('allows the ID verification fake in LOCAL and TEST only', () => {
    for (const environment of ['LOCAL', 'TEST']) {
      const config = loadConfig(
        validEnv({ SUAS_ENV: environment, SUAS_ID_VERIFICATION_MODE: 'fake' }),
      );
      expect(config.idVerification.mode).toBe('fake');
    }
    expect(
      issuesFor(validEnv({ SUAS_ENV: 'STAGING', SUAS_ID_VERIFICATION_MODE: 'fake' })),
    ).toContain('SUAS_ID_VERIFICATION_MODE=fake is forbidden in STAGING');
  });
});
