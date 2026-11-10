/**
 * Typed configuration contract.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §2 (canonical environments)
 * - SUAS-specs ENVIRONMENT.md §3 (canonical configuration variables)
 * - SUAS-specs ENVIRONMENT.md §4 (configuration precedence)
 * - SUAS-specs ENVIRONMENT.md §5 (startup validation, fail closed)
 * - SUAS-specs ENVIRONMENT.md §6 (secret classes)
 * - SUAS-specs HANDOFF.md §7 (environment contract)
 *
 * Configuration may select an implementation mechanism. It may not redefine
 * released product/domain semantics, and it may not enable a surface the
 * release manifest marks UNAVAILABLE or FUTURE (ENVIRONMENT.md §4).
 */

import { z } from 'zod';
import { isSyntheticEmail } from '../testing/fixture-boundary.js';
import { corsPinIssue, parseAllowedOrigins } from './cors-origins.js';
import {
  VA_CONFIRMATION_PROJECTION_ID,
  VA_CONFIRMATION_SANDBOX_BASE_URL,
} from '../identity/va-confirmation.js';
import {
  CORS_GUARD_SPEC_VERSION,
  RELEASE_MANIFEST,
  SPEC_018_PRODUCTION_AUTHORIZED,
  SPEC_VERSION,
} from '../release/pins.js';

/** ENVIRONMENT.md §2. Exactly these logical environment classes exist. */
export const ENVIRONMENT_CLASSES = ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'] as const;
export type EnvironmentClass = (typeof ENVIRONMENT_CLASSES)[number];

/** ENVIRONMENT.md §3 "Data / persistence". */
export const MIGRATIONS_MODES = ['off', 'validate', 'apply'] as const;
export type MigrationsMode = (typeof MIGRATIONS_MODES)[number];

/**
 * Database TLS. `verify` encrypts the connection and verifies the server
 * certificate chain and host name; `disable` is plain TCP for LOCAL/TEST.
 * Unverified TLS is deliberately not offered.
 */
export const DATABASE_SSL_MODES = ['disable', 'verify'] as const;
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number];

/**
 * ENVIRONMENT.md §3 "Notifications". Resend is the sole released EMAIL
 * provider. SMS remains restricted to the provider-neutral test modes.
 */
export const COMMUNICATION_MODES = ['disabled', 'fake', 'sink'] as const;
export type CommunicationMode = (typeof COMMUNICATION_MODES)[number];
export const EMAIL_MODES = [...COMMUNICATION_MODES, 'resend', 'ses'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];

/**
 * V1_PROJECT_PLAN.md §2.2 and §4.1: AWS-backed capability ports. Each has a fake
 * for LOCAL/TEST. Real AWS modes are refused in LOCAL/TEST; fakes are refused in
 * PRODUCTION (plan §7). The default is `disabled` so existing environments need
 * no new variables.
 */
export const MODEL_INFERENCE_MODES = ['disabled', 'fake', 'bedrock'] as const;
export type ModelInferenceMode = (typeof MODEL_INFERENCE_MODES)[number];
export const OBJECT_STORAGE_MODES = ['disabled', 'fake', 's3'] as const;
export type ObjectStorageMode = (typeof OBJECT_STORAGE_MODES)[number];
/** No real provider is chosen yet (plan §8 item 2), so only a fake exists. */
export const ID_VERIFICATION_MODES = ['disabled', 'fake'] as const;
/**
 * Chat push (V1_PROJECT_PLAN.md §2.2): `local` is a process-local WebSocket server
 * for LOCAL/TEST; `apigw` is the API Gateway WebSocket API. Messages are stored and
 * listed over REST in every mode, so `disabled` loses only live updates.
 */
export const CHAT_PUSH_MODES = ['disabled', 'local', 'apigw'] as const;
export type ChatPushMode = (typeof CHAT_PUSH_MODES)[number];
export type IdVerificationMode = (typeof ID_VERIFICATION_MODES)[number];
/**
 * VA Veteran Confirmation (suas-specs #72 R9.1, proposal): `fixture` is LOCAL and TEST
 * only; `sandbox` is the VA sandbox, refused in PRODUCTION until D-035 settles.
 */
export const VA_CONFIRMATION_MODES = ['disabled', 'fixture', 'sandbox'] as const;
export type VaConfirmationMode = (typeof VA_CONFIRMATION_MODES)[number];

/** One provisioned synthetic fixture. Identity is the pair, not the email address. */
export interface StagingFixturePrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

const FIXTURE_PRINCIPAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseStagingFixtureRegistry(value: string | undefined): {
  readonly principals: readonly StagingFixturePrincipal[];
  readonly issue: string | undefined;
} {
  if (value === undefined) return { principals: [], issue: undefined };
  const entries = splitCsv(value);
  if (entries.length > 10) {
    return {
      principals: [],
      issue: 'SUAS_STAGING_FIXTURE_REGISTRY must contain at most 10 principals.',
    };
  }
  const principals: StagingFixturePrincipal[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    const tenantId = separator === -1 ? '' : entry.slice(0, separator);
    const userId = separator === -1 ? '' : entry.slice(separator + 1);
    if (
      separator === -1 ||
      !FIXTURE_PRINCIPAL_ID.test(tenantId) ||
      !FIXTURE_PRINCIPAL_ID.test(userId)
    ) {
      return {
        principals: [],
        issue: 'SUAS_STAGING_FIXTURE_REGISTRY entries must be tenant-id:user-id pairs.',
      };
    }
    principals.push({ tenantId: tenantId.toLowerCase(), userId: userId.toLowerCase() });
  }
  return { principals, issue: undefined };
}

const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const CHAT_WS_ENDPOINT_PATTERN =
  /^https:\/\/[a-z0-9]+\.execute-api\.[a-z]{2}(?:-[a-z]+)+-\d\.amazonaws\.com\/[A-Za-z0-9_-]+$/;
const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export const BROWSER_AUTH_MODES = ['disabled', 'email_otp'] as const;
export type BrowserAuthMode = (typeof BROWSER_AUTH_MODES)[number];

/** ENVIRONMENT.md §3 "Fulfillment adapters". Real adapter modes require D-017–D-020. */
export const ADAPTER_MODES = [
  'manual',
  'fake',
  'disabled',
  'uber_guest_rides',
  'amadeus_lodging',
] as const;
export type AdapterMode = (typeof ADAPTER_MODES)[number];

/** ENVIRONMENT.md §3 "Support Signal / safety / reporting". */
export const SUPPORT_SIGNAL_MODES = ['disabled', 'fixture'] as const;
export type SupportSignalMode = (typeof SUPPORT_SIGNAL_MODES)[number];

export const SAFETY_COPY_MODES = ['placeholder_test_only', 'approved', 'disabled'] as const;
export type SafetyCopyMode = (typeof SAFETY_COPY_MODES)[number];

export const SENSITIVE_AGGREGATE_REPORTING_MODES = ['disabled'] as const;
export type SensitiveAggregateReporting = (typeof SENSITIVE_AGGREGATE_REPORTING_MODES)[number];

/**
 * Environment classes that must never reach real veteran data or real external
 * side effects. ENVIRONMENT.md §2 table; HANDOFF.md §7.
 */
export const SYNTHETIC_ONLY_ENVIRONMENTS: readonly EnvironmentClass[] = [
  'LOCAL',
  'TEST',
  'STAGING',
];

/**
 * Substrings that mark a connection target as a probable production data resource.
 *
 * ENVIRONMENT.md §5 requires startup to fail closed when LOCAL/TEST/STAGING points
 * at known production data resources. The released contract does not name a
 * detection mechanism, so this deny-list is an implementation-owned guard: it is a
 * safety net, not an authority. Environment class itself is always explicit and is
 * never inferred from a database name (ENVIRONMENT.md §2).
 */
export const PRODUCTION_DATA_MARKERS = ['prod', 'production', 'live'] as const;

const MIN_SESSION_SECRET_LENGTH = 32;

/** Treat an unset or whitespace-only variable as absent so it fails closed as "required". */
const optionalRaw = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().optional());

function splitCsv(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    ),
  ];
}

function requiredEnum<const T extends readonly string[]>(
  varName: string,
  allowed: T,
  guidance: string,
): z.ZodType<T[number], z.ZodTypeDef, unknown> {
  return optionalRaw.superRefine((value, ctx) => {
    if (value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${varName} is required and must be one of ${allowed.join(' | ')}. ${guidance}`,
      });
      return;
    }
    if (!allowed.includes(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${varName}="${value}" is not a released value. Allowed: ${allowed.join(' | ')}. ${guidance}`,
      });
    }
  }) as unknown as z.ZodType<T[number], z.ZodTypeDef, unknown>;
}

/** Like {@link requiredEnum}, but an unset variable takes `fallback`. */
function optionalEnum<const T extends readonly string[]>(
  varName: string,
  allowed: T,
  fallback: T[number],
): z.ZodType<T[number], z.ZodTypeDef, unknown> {
  return optionalRaw
    .superRefine((value, ctx) => {
      if (value !== undefined && !allowed.includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${varName}="${value}" is not a valid value. Allowed: ${allowed.join(' | ')}.`,
        });
      }
    })
    .transform((value) => (value ?? fallback) as T[number]);
}

/** ENVIRONMENT.md §5: fail closed on invalid/unknown values, including booleans. */
function strictBoolean(
  varName: string,
  guidance: string,
): z.ZodType<boolean, z.ZodTypeDef, unknown> {
  return optionalRaw
    .superRefine((value, ctx) => {
      if (value === undefined || (value !== 'true' && value !== 'false')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${varName} is required and must be exactly "true" or "false". ${guidance}`,
        });
      }
    })
    .transform((value) => value === 'true');
}

const rawConfigSchema = z.object({
  // --- Required in every environment. ENVIRONMENT.md §3. ---
  SUAS_ENV: requiredEnum(
    'SUAS_ENV',
    ENVIRONMENT_CLASSES,
    'ENVIRONMENT.md §2: environment class is explicit and is never inferred from hostname, branch name, NODE_ENV, cloud account, or database name.',
  ),
  SUAS_SPEC_VERSION: optionalRaw,
  SUAS_RELEASE_MANIFEST: optionalRaw,
  SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: strictBoolean(
    'SUAS_ALLOW_REAL_EXTERNAL_EFFECTS',
    'ENVIRONMENT.md §3 rules 3-4.',
  ),

  // --- Data / persistence. ENVIRONMENT.md §3. ---
  DATABASE_URL: optionalRaw,
  DATABASE_POOL_MAX: optionalRaw,
  DATABASE_SSL_MODE: optionalRaw,
  // Path to a PEM CA bundle (e.g. the AWS RDS global bundle). Read at pool creation.
  DATABASE_SSL_CA_FILE: optionalRaw,
  SUAS_MIGRATIONS_MODE: requiredEnum(
    'SUAS_MIGRATIONS_MODE',
    MIGRATIONS_MODES,
    'ENVIRONMENT.md §3 "Data / persistence"; production automatic-migration policy must be explicit in deployment runbooks.',
  ),
  // D-053. Both stay unset except for an explicit reset of a named synthetic
  // disposable database. They are not a startup migrations mode.
  SUAS_MIGRATION_RESET_ALLOWLIST: optionalRaw,
  SUAS_MIGRATION_RESET_SYNTHETIC_MARKER: optionalRaw,

  // --- Auth / sessions. ENVIRONMENT.md §3, §6. ---
  SUAS_SESSION_SECRET: optionalRaw,
  SUAS_BROWSER_AUTH_MODE: requiredEnum(
    'SUAS_BROWSER_AUTH_MODE',
    BROWSER_AUTH_MODES,
    'ENVIRONMENT.md §3 "Auth / sessions".',
  ),
  SUAS_BROWSER_TENANT_ID: optionalRaw,

  // D-035 evidence only. This is opt-in and never enables production wiring.
  SUAS_VA_SANDBOX_OAUTH_ENABLED: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_CLIENT_ID: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_CLIENT_SECRET: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_AUTHORIZATION_ENDPOINT: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_REDIRECT_URI: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_TOKEN_ENDPOINT: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_STATUS_ENDPOINT: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_ISSUER: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_AUDIENCE: optionalRaw,
  SUAS_VA_SANDBOX_OAUTH_JWKS_JSON: optionalRaw,

  // --- Notifications. ENVIRONMENT.md §3. ---
  SUAS_EMAIL_MODE: requiredEnum(
    'SUAS_EMAIL_MODE',
    EMAIL_MODES,
    'D-004 selects Resend as the sole EMAIL provider.',
  ),
  SUAS_SMS_MODE: requiredEnum(
    'SUAS_SMS_MODE',
    COMMUNICATION_MODES,
    'Production external SMS is not valid in v0.1.1; the SMS provider decision has not closed.',
  ),
  // Resend slots are required only when the released mode is selected.
  // Secrets stay empty in committed examples (ENVIRONMENT.md §6–§7).
  RESEND_API_KEY: optionalRaw,
  // Shared by `resend` and `ses`. SES credentials are never configured here:
  // the AWS SDK default provider chain supplies them (the Lambda role).
  SUAS_EMAIL_FROM: optionalRaw,

  // --- AWS capability ports. V1_PROJECT_PLAN.md §2.2, §4.1. ---
  SUAS_AWS_REGION: optionalRaw,
  SUAS_MODEL_INFERENCE_MODE: optionalEnum(
    'SUAS_MODEL_INFERENCE_MODE',
    MODEL_INFERENCE_MODES,
    'disabled',
  ),
  // Unset means the capability is reported unavailable: the model is not chosen.
  SUAS_BEDROCK_MODEL_ID: optionalRaw,
  SUAS_OBJECT_STORAGE_MODE: optionalEnum(
    'SUAS_OBJECT_STORAGE_MODE',
    OBJECT_STORAGE_MODES,
    'disabled',
  ),
  SUAS_S3_BUCKET: optionalRaw,
  SUAS_ID_VERIFICATION_MODE: optionalEnum(
    'SUAS_ID_VERIFICATION_MODE',
    ID_VERIFICATION_MODES,
    'disabled',
  ),
  SUAS_VA_CONFIRMATION_MODE: optionalEnum(
    'SUAS_VA_CONFIRMATION_MODE',
    VA_CONFIRMATION_MODES,
    'disabled',
  ),
  SUAS_VA_CONFIRMATION_BASE_URL: optionalRaw,
  // Server-side secret (D035 §6): shown only as a configured flag, never its value.
  SUAS_VA_CONFIRMATION_API_KEY: optionalRaw,
  SUAS_VA_CONFIRMATION_PROJECTION_ID: optionalRaw,
  // D-052. Public self sign-up stays off unless LOCAL or TEST sets "enabled".
  SUAS_PUBLIC_SIGN_UP: optionalRaw,
  // Addresses the STAGING provision command may create. Not an admission list.
  SUAS_STAGING_AUTH_EMAILS: optionalRaw,
  // Explicit tenant-id:user-id pairs STAGING auth admits. Empty admits nobody.
  SUAS_STAGING_FIXTURE_REGISTRY: optionalRaw,

  SUAS_CHAT_PUSH_MODE: optionalEnum('SUAS_CHAT_PUSH_MODE', CHAT_PUSH_MODES, 'disabled'),
  // `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}` of the WebSocket API.
  SUAS_CHAT_WS_ENDPOINT: optionalRaw,
  // Optional `wss://` URL clients open instead of the execute-api host, such as a custom
  // domain mapped to the same WebSocket API stage. `apigw` only; unset keeps the default.
  SUAS_CHAT_WS_PUBLIC_URL: optionalRaw,
  // Port for the local WebSocket server (SUAS_CHAT_PUSH_MODE=local). Defaults to 3001.
  SUAS_CHAT_LOCAL_WS_PORT: optionalRaw,

  // --- Fulfillment adapters. ENVIRONMENT.md §3. ---
  SUAS_TRANSPORTATION_ADAPTER_MODE: requiredEnum(
    'SUAS_TRANSPORTATION_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),
  SUAS_SHELTER_ADAPTER_MODE: requiredEnum(
    'SUAS_SHELTER_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),
  SUAS_FOOD_ADAPTER_MODE: requiredEnum(
    'SUAS_FOOD_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),
  SUAS_PEER_SUPPORT_ADAPTER_MODE: requiredEnum(
    'SUAS_PEER_SUPPORT_ADAPTER_MODE',
    ADAPTER_MODES,
    'A real adapter mode requires the corresponding D-017–D-020 decision and a released manifest update.',
  ),
  SUAS_UBER_GUEST_RIDES_CLIENT_ID: optionalRaw,
  SUAS_UBER_GUEST_RIDES_CLIENT_SECRET: optionalRaw,
  SUAS_UBER_GUEST_RIDES_TOKEN_URL: optionalRaw,
  SUAS_UBER_GUEST_RIDES_API_BASE_URL: optionalRaw,
  SUAS_UBER_GUEST_RIDES_WEBHOOK_SECRET: optionalRaw,
  SUAS_AMADEUS_LODGING_CLIENT_ID: optionalRaw,
  SUAS_AMADEUS_LODGING_CLIENT_SECRET: optionalRaw,
  SUAS_AMADEUS_LODGING_TOKEN_URL: optionalRaw,
  SUAS_AMADEUS_LODGING_API_BASE_URL: optionalRaw,

  // --- Support Signal / safety / reporting. ENVIRONMENT.md §3, §5. ---
  SUAS_SUPPORT_SIGNAL_MODE: requiredEnum(
    'SUAS_SUPPORT_SIGNAL_MODE',
    SUPPORT_SIGNAL_MODES,
    'D-011 released sv-001 as implementation-authoritative, not production-operating. ENVIRONMENT.md §3 still allows only disabled|fixture; "fixture" is never production authority.',
  ),
  SUAS_SAFETY_COPY_MODE: requiredEnum(
    'SUAS_SAFETY_COPY_MODE',
    SAFETY_COPY_MODES,
    '"approved" (D-012, SAFETY_COPY.md v0.1.5) renders the released crisis copy/destinations; "placeholder_test_only" renders the reserved placeholder and is never production authority.',
  ),
  SUAS_SENSITIVE_AGGREGATE_REPORTING: requiredEnum(
    'SUAS_SENSITIVE_AGGREGATE_REPORTING',
    SENSITIVE_AGGREGATE_REPORTING_MODES,
    'Sensitive aggregate reporting stays disabled until approved D-025 projection, access, audit, retention, and human-review evidence is accepted.',
  ),

  // --- Implementation-owned mechanism (not released product semantics). ---
  SUAS_HTTP_PORT: optionalRaw,
  SUAS_HTTP_HOST: optionalRaw,
  SUAS_LOG_LEVEL: optionalRaw,
  // "enabled" gives demo@example.invalid the fixed sign-in code 123456
  // (src/auth/demo-fixed-code.ts). Allowed for LOCAL and synthetic STAGING.
  // Rejected for TEST and PRODUCTION.
  SUAS_DEMO_FIXED_CODE: optionalRaw,
  // Comma-separated exact origins allowed to call the server cross-origin
  // (src/http/origin-policy.ts). Unset or empty means no CORS headers at all.
  SUAS_CORS_ALLOWED_ORIGINS: optionalRaw,
});

/** Log levels. Implementation mechanism; ENVIRONMENT.md §6 governs what may be logged. */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Every configuration variable this build reads.
 * ENVIRONMENT.md §7 requires `.env.example` to carry the names with safe
 * placeholders; the repository-hygiene test asserts the two stay in step.
 */
export const CONFIG_VARIABLE_NAMES: readonly string[] = Object.keys(rawConfigSchema.shape);

export interface SuasConfig {
  readonly environment: EnvironmentClass;
  readonly specVersion: string;
  readonly releaseManifest: string;
  readonly allowRealExternalEffects: boolean;
  readonly database: {
    readonly url: string | undefined;
    readonly poolMax: number;
    readonly migrationsMode: MigrationsMode;
    /** Names or URLs that may be wiped by `migrate reset`. Empty refuses every reset. */
    readonly resetAllowlist: readonly string[];
    /** Substring required in the database name before a reset. Unset refuses every reset. */
    readonly resetSyntheticMarker: string | undefined;
    readonly ssl: {
      readonly mode: DatabaseSslMode;
      readonly caFile: string | undefined;
    };
  };
  readonly sessionSecret: string | undefined;
  readonly browserAuth: {
    readonly mode: BrowserAuthMode;
    readonly tenantId: string | undefined;
  };
  readonly vaSandboxOAuth: {
    readonly enabled: boolean;
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
    readonly authorizationEndpoint: string | undefined;
    readonly redirectUri: string | undefined;
    readonly tokenEndpoint: string | undefined;
    readonly statusEndpoint: string | undefined;
    readonly issuer: string | undefined;
    readonly audience: string | undefined;
    readonly jwksJson: string | undefined;
  };
  readonly notifications: {
    readonly email: EmailMode;
    readonly sms: CommunicationMode;
    readonly resendApiKey: string | undefined;
    readonly emailFrom: string | undefined;
  };
  readonly aws: {
    readonly region: string | undefined;
  };
  readonly modelInference: {
    readonly mode: ModelInferenceMode;
    /** Unset means the capability is unavailable (model not chosen). */
    readonly bedrockModelId: string | undefined;
  };
  readonly objectStorage: {
    readonly mode: ObjectStorageMode;
    readonly bucket: string | undefined;
  };
  readonly idVerification: {
    readonly mode: IdVerificationMode;
  };
  readonly vaConfirmation: {
    readonly mode: VaConfirmationMode;
    readonly baseUrl: string | undefined;
    readonly apiKey: string | undefined;
  };
  /** Public self sign-up. Startup refuses `enabled` outside LOCAL and TEST. */
  readonly publicSignUp: boolean;
  /** Normalized emails the STAGING provision command may create. Not admission. */
  readonly stagingAuthEmails: readonly string[];
  /**
   * Explicit, immutable (tenant id, user id) pairs STAGING auth admits.
   * Empty or absent admits nobody. The demo account is not added implicitly.
   */
  readonly stagingFixturePrincipals: readonly StagingFixturePrincipal[];
  readonly chatPush: {
    readonly mode: ChatPushMode;
    /** WebSocket API management endpoint; set only for `apigw`. */
    readonly apiGatewayEndpoint: string | undefined;
    /** URL handed to clients when it differs from the management endpoint; `apigw` only. */
    readonly publicUrl: string | undefined;
    readonly localPort: number;
  };
  readonly adapters: {
    readonly transportation: AdapterMode;
    readonly shelter: AdapterMode;
    readonly food: AdapterMode;
    readonly peerSupport: AdapterMode;
    readonly uberGuestRides: {
      readonly clientId: string | undefined;
      readonly clientSecret: string | undefined;
      readonly tokenUrl: string | undefined;
      readonly apiBaseUrl: string | undefined;
      readonly webhookSecret: string | undefined;
    };
    readonly amadeusLodging: {
      readonly clientId: string | undefined;
      readonly clientSecret: string | undefined;
      readonly tokenUrl: string | undefined;
      readonly apiBaseUrl: string | undefined;
    };
  };
  readonly supportSignalMode: SupportSignalMode;
  readonly safetyCopyMode: SafetyCopyMode;
  readonly sensitiveAggregateReporting: SensitiveAggregateReporting;
  readonly http: {
    readonly host: string;
    readonly port: number;
  };
  readonly logLevel: LogLevel;
  /**
   * Fixed sign-in code for demo@example.invalid. True only when the flag is
   * enabled and the environment is LOCAL or STAGING. Issuing the code still
   * requires the gates in src/auth/demo-fixed-code.ts.
   */
  readonly demoFixedCode: boolean;
  /**
   * Exact origins allowed to make cross-origin requests (CORS and browser writes).
   * Empty means the feature is off. Parsed and validated from
   * SUAS_CORS_ALLOWED_ORIGINS.
   */
  readonly corsAllowedOrigins: readonly string[];
}

function parsePositiveInt(
  varName: string,
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
  ctx: z.RefinementCtx,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${varName}="${raw}" must be a positive integer.`,
    });
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (value < bounds.min || value > bounds.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${varName}=${value} is out of the accepted range ${bounds.min}-${bounds.max}.`,
    });
    return fallback;
  }
  return value;
}

/**
 * Returns the production-data markers matched by a connection string, if any.
 * Only the host and database-name components are inspected; credentials are
 * never read or logged (ENVIRONMENT.md §6).
 */
export function productionDataMarkersIn(databaseUrl: string): string[] {
  let host = '';
  let databaseName = '';
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname.toLowerCase();
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  } catch {
    // Unparseable connection strings are reported by the DATABASE_URL check itself.
    return [];
  }
  const haystack = `${host} ${databaseName}`;
  const tokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
  return PRODUCTION_DATA_MARKERS.filter((marker) => tokens.includes(marker));
}

function validateProviderEndpoint(
  varName: string,
  rawUrl: string | undefined,
  environment: EnvironmentClass,
  ctx: z.RefinementCtx,
): void {
  if (rawUrl === undefined) return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${varName} must be an absolute HTTPS URL.`,
    });
    return;
  }

  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const localHttp = (environment === 'LOCAL' || environment === 'TEST') && loopback;
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHttp)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `${varName} must use HTTPS; HTTP is permitted only for localhost/127.0.0.1 in LOCAL or TEST. ` +
        'This prevents provider credentials from being redirected to an arbitrary cleartext endpoint.',
    });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${varName} must not contain URL-embedded credentials.`,
    });
  }
}

/** Why `SUAS_CHAT_WS_PUBLIC_URL` is not a usable client URL, or undefined when it is. */
function chatWsPublicUrlIssue(value: string): string | undefined {
  const message =
    'SUAS_CHAT_WS_PUBLIC_URL must be a wss:// URL with a host name and no credentials, query or fragment.';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return message;
  }
  const bad =
    parsed.protocol !== 'wss:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value.includes('?') ||
    value.includes('#');
  return bad ? message : undefined;
}

/**
 * Guards for the AWS-backed capability ports (V1_PROJECT_PLAN.md §4.1, §7).
 *
 * - A real AWS mode (`ses`, `bedrock`, `s3`) is refused in LOCAL/TEST, like
 *   Resend (ENVIRONMENT.md §3 rule 3, AGENTS.md rule 4), and needs its region.
 * - A fake mode is refused in PRODUCTION. Fake ID verification is also refused
 *   in STAGING: it would pass anyone through the identity gate (D-052).
 */
function validateAwsCapabilities(
  raw: z.output<typeof rawConfigSchema>,
  environment: EnvironmentClass,
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  };

  const realModes: ReadonlyArray<readonly [string, string, string]> = [
    ['SUAS_EMAIL_MODE', raw.SUAS_EMAIL_MODE, 'ses'],
    ['SUAS_MODEL_INFERENCE_MODE', raw.SUAS_MODEL_INFERENCE_MODE, 'bedrock'],
    ['SUAS_OBJECT_STORAGE_MODE', raw.SUAS_OBJECT_STORAGE_MODE, 's3'],
    ['SUAS_CHAT_PUSH_MODE', raw.SUAS_CHAT_PUSH_MODE, 'apigw'],
  ];
  const awsEnabled = realModes.filter(([, value, real]) => value === real);
  for (const [varName, value] of awsEnabled) {
    if (environment === 'LOCAL' || environment === 'TEST') {
      issue(`${varName}=${value} is forbidden in ${environment}; use fake or sink.`);
    }
  }
  if (awsEnabled.length > 0 && raw.SUAS_AWS_REGION === undefined) {
    issue('SUAS_AWS_REGION is required when an AWS-backed capability mode is selected.');
  }
  if (raw.SUAS_AWS_REGION !== undefined && !AWS_REGION_PATTERN.test(raw.SUAS_AWS_REGION)) {
    issue('SUAS_AWS_REGION must be an AWS region name such as us-west-2.');
  }

  if (raw.SUAS_EMAIL_MODE === 'ses' && raw.SUAS_EMAIL_FROM === undefined) {
    issue('SUAS_EMAIL_FROM is required when SUAS_EMAIL_MODE=ses.');
  }
  if (raw.SUAS_OBJECT_STORAGE_MODE === 's3') {
    if (raw.SUAS_S3_BUCKET === undefined) {
      issue('SUAS_S3_BUCKET is required when SUAS_OBJECT_STORAGE_MODE=s3.');
    }
  }
  if (raw.SUAS_S3_BUCKET !== undefined && !S3_BUCKET_PATTERN.test(raw.SUAS_S3_BUCKET)) {
    issue('SUAS_S3_BUCKET must be a valid S3 bucket name.');
  }

  if (raw.SUAS_CHAT_PUSH_MODE === 'apigw') {
    if (raw.SUAS_CHAT_WS_ENDPOINT === undefined) {
      issue('SUAS_CHAT_WS_ENDPOINT is required when SUAS_CHAT_PUSH_MODE=apigw.');
    } else if (!CHAT_WS_ENDPOINT_PATTERN.test(raw.SUAS_CHAT_WS_ENDPOINT)) {
      issue(
        'SUAS_CHAT_WS_ENDPOINT must be https://<api-id>.execute-api.<region>.amazonaws.com/<stage>.',
      );
    }
  }
  if (raw.SUAS_CHAT_WS_PUBLIC_URL !== undefined) {
    if (raw.SUAS_CHAT_PUSH_MODE !== 'apigw') {
      issue('SUAS_CHAT_WS_PUBLIC_URL requires SUAS_CHAT_PUSH_MODE=apigw.');
    }
    const publicUrlIssue = chatWsPublicUrlIssue(raw.SUAS_CHAT_WS_PUBLIC_URL);
    if (publicUrlIssue !== undefined) issue(publicUrlIssue);
  }
  // The local server keeps its sockets in one process, so it cannot serve a deployed,
  // multi-instance environment (AGENTS.md rule 8).
  if (raw.SUAS_CHAT_PUSH_MODE === 'local' && environment !== 'LOCAL' && environment !== 'TEST') {
    issue(`SUAS_CHAT_PUSH_MODE=local is allowed only in LOCAL and TEST, not ${environment}.`);
  }

  if (
    raw.SUAS_ID_VERIFICATION_MODE === 'fake' &&
    environment !== 'LOCAL' &&
    environment !== 'TEST'
  ) {
    issue(
      `SUAS_ID_VERIFICATION_MODE=fake is forbidden in ${environment}. ` +
        'Fake ID verification is refused outside LOCAL and TEST.',
    );
  }

  if (environment === 'PRODUCTION') {
    for (const [varName, value] of [
      ['SUAS_MODEL_INFERENCE_MODE', raw.SUAS_MODEL_INFERENCE_MODE],
      ['SUAS_OBJECT_STORAGE_MODE', raw.SUAS_OBJECT_STORAGE_MODE],
    ] as const) {
      if (value === 'fake') {
        issue(`${varName}=fake is forbidden in PRODUCTION (V1_PROJECT_PLAN.md §7).`);
      }
    }
  }
}

/**
 * VA Veteran Confirmation modes (suas-specs #72 R9.1, proposal; D035 §5, §6, §14 items
 * 2-4, 9-10). Every mismatch fails closed; issue text never includes the key.
 */
function validateVaConfirmation(
  raw: z.output<typeof rawConfigSchema>,
  environment: EnvironmentClass,
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  };
  const mode = raw.SUAS_VA_CONFIRMATION_MODE;

  if (
    raw.SUAS_VA_CONFIRMATION_PROJECTION_ID !== undefined &&
    raw.SUAS_VA_CONFIRMATION_PROJECTION_ID !== VA_CONFIRMATION_PROJECTION_ID
  ) {
    issue(`SUAS_VA_CONFIRMATION_PROJECTION_ID must be ${VA_CONFIRMATION_PROJECTION_ID} when set.`);
  }
  if (mode === 'fixture' && environment !== 'LOCAL' && environment !== 'TEST') {
    issue(
      `SUAS_VA_CONFIRMATION_MODE=fixture is allowed only in LOCAL and TEST, not ${environment}.`,
    );
  }
  if (mode !== 'sandbox') return;

  if (environment === 'PRODUCTION') {
    issue(
      'SUAS_VA_CONFIRMATION_MODE=sandbox is forbidden in PRODUCTION; PRODUCTION allows disabled only.',
    );
  }
  if (environment === 'TEST') {
    issue(
      'SUAS_VA_CONFIRMATION_MODE=sandbox is allowed only in STAGING and LOCAL, not TEST; TEST uses fixture or disabled.',
    );
  }
  if (raw.SUAS_VA_CONFIRMATION_BASE_URL !== VA_CONFIRMATION_SANDBOX_BASE_URL) {
    issue(
      `SUAS_VA_CONFIRMATION_BASE_URL must be exactly ${VA_CONFIRMATION_SANDBOX_BASE_URL} when SUAS_VA_CONFIRMATION_MODE=sandbox.`,
    );
  }
  const key = raw.SUAS_VA_CONFIRMATION_API_KEY;
  if (key === undefined) {
    issue('SUAS_VA_CONFIRMATION_API_KEY is required when SUAS_VA_CONFIRMATION_MODE=sandbox.');
  } else if (!/^[\x21-\x7E]+$/.test(key)) {
    issue('SUAS_VA_CONFIRMATION_API_KEY is malformed: printable characters only, no spaces.');
  }
}

/**
 * Full configuration schema including the ENVIRONMENT.md §5 cross-field
 * startup-validation invariants. Every failure here is fail-closed by design.
 */
export const configSchema = rawConfigSchema.superRefine((raw, ctx) => {
  const environment = raw.SUAS_ENV;

  if (
    raw.SUAS_DEMO_FIXED_CODE !== undefined &&
    raw.SUAS_DEMO_FIXED_CODE !== 'enabled' &&
    raw.SUAS_DEMO_FIXED_CODE !== 'disabled'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUAS_DEMO_FIXED_CODE must be exactly "enabled" or "disabled" when set.',
    });
  }
  if (
    raw.SUAS_PUBLIC_SIGN_UP !== undefined &&
    raw.SUAS_PUBLIC_SIGN_UP !== 'enabled' &&
    raw.SUAS_PUBLIC_SIGN_UP !== 'disabled'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUAS_PUBLIC_SIGN_UP must be exactly "enabled" or "disabled" when set.',
    });
  }
  if (raw.SUAS_PUBLIC_SIGN_UP === 'enabled' && environment !== 'LOCAL' && environment !== 'TEST') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'SUAS_PUBLIC_SIGN_UP=enabled is refused outside LOCAL and TEST. ' +
        'STAGING and PRODUCTION fail closed.',
    });
  }

  const stagingPrincipals = splitCsv(raw.SUAS_STAGING_AUTH_EMAILS).map((email) =>
    email.toLowerCase(),
  );
  if (stagingPrincipals.length > 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUAS_STAGING_AUTH_EMAILS must contain at most 10 addresses.',
    });
  }
  if (stagingPrincipals.some((email) => !isSyntheticEmail(email))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUAS_STAGING_AUTH_EMAILS must contain only synthetic fixture addresses.',
    });
  }
  const registry = parseStagingFixtureRegistry(raw.SUAS_STAGING_FIXTURE_REGISTRY);
  if (registry.issue !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: registry.issue,
    });
  }

  if (
    raw.SUAS_DEMO_FIXED_CODE === 'enabled' &&
    environment !== 'LOCAL' &&
    environment !== 'STAGING'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'SUAS_DEMO_FIXED_CODE=enabled is forbidden outside SUAS_ENV=LOCAL and SUAS_ENV=STAGING.',
    });
  }

  const corsOrigins = parseAllowedOrigins(raw.SUAS_CORS_ALLOWED_ORIGINS, environment);
  for (const message of corsOrigins.issues) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  const corsPin = corsPinIssue(corsOrigins.origins, CORS_GUARD_SPEC_VERSION);
  if (corsPin !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: corsPin });
  }

  const vaSandboxEnabled = raw.SUAS_VA_SANDBOX_OAUTH_ENABLED === 'true';
  if (
    raw.SUAS_VA_SANDBOX_OAUTH_ENABLED !== undefined &&
    raw.SUAS_VA_SANDBOX_OAUTH_ENABLED !== 'true' &&
    raw.SUAS_VA_SANDBOX_OAUTH_ENABLED !== 'false'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUAS_VA_SANDBOX_OAUTH_ENABLED must be exactly "true" or "false" when set.',
    });
  }
  if (vaSandboxEnabled) {
    if (environment === 'PRODUCTION')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SUAS_VA_SANDBOX_OAUTH_ENABLED is sandbox-only and is forbidden in PRODUCTION.',
      });
    for (const name of [
      'SUAS_VA_SANDBOX_OAUTH_CLIENT_ID',
      'SUAS_VA_SANDBOX_OAUTH_CLIENT_SECRET',
      'SUAS_VA_SANDBOX_OAUTH_AUTHORIZATION_ENDPOINT',
      'SUAS_VA_SANDBOX_OAUTH_TOKEN_ENDPOINT',
      'SUAS_VA_SANDBOX_OAUTH_REDIRECT_URI',
      'SUAS_VA_SANDBOX_OAUTH_STATUS_ENDPOINT',
      'SUAS_VA_SANDBOX_OAUTH_ISSUER',
      'SUAS_VA_SANDBOX_OAUTH_AUDIENCE',
      'SUAS_VA_SANDBOX_OAUTH_JWKS_JSON',
    ] as const)
      if (raw[name] === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} is required when SUAS_VA_SANDBOX_OAUTH_ENABLED=true.`,
        });
    validateProviderEndpoint(
      'SUAS_VA_SANDBOX_OAUTH_AUTHORIZATION_ENDPOINT',
      raw.SUAS_VA_SANDBOX_OAUTH_AUTHORIZATION_ENDPOINT,
      environment,
      ctx,
    );
    validateProviderEndpoint(
      'SUAS_VA_SANDBOX_OAUTH_REDIRECT_URI',
      raw.SUAS_VA_SANDBOX_OAUTH_REDIRECT_URI,
      environment,
      ctx,
    );
    validateProviderEndpoint(
      'SUAS_VA_SANDBOX_OAUTH_TOKEN_ENDPOINT',
      raw.SUAS_VA_SANDBOX_OAUTH_TOKEN_ENDPOINT,
      environment,
      ctx,
    );
    validateProviderEndpoint(
      'SUAS_VA_SANDBOX_OAUTH_STATUS_ENDPOINT',
      raw.SUAS_VA_SANDBOX_OAUTH_STATUS_ENDPOINT,
      environment,
      ctx,
    );
    try {
      if (
        raw.SUAS_VA_SANDBOX_OAUTH_JWKS_JSON !== undefined &&
        !Array.isArray(JSON.parse(raw.SUAS_VA_SANDBOX_OAUTH_JWKS_JSON))
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SUAS_VA_SANDBOX_OAUTH_JWKS_JSON must be a JSON array of public JWKs.',
      });
    }
  }

  validateProviderEndpoint(
    'SUAS_AMADEUS_LODGING_TOKEN_URL',
    raw.SUAS_AMADEUS_LODGING_TOKEN_URL,
    environment,
    ctx,
  );
  validateProviderEndpoint(
    'SUAS_AMADEUS_LODGING_API_BASE_URL',
    raw.SUAS_AMADEUS_LODGING_API_BASE_URL,
    environment,
    ctx,
  );

  // ENVIRONMENT.md §3 rule 1 / §5 "spec version ... mismatch".
  if (raw.SUAS_SPEC_VERSION !== SPEC_VERSION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `SUAS_SPEC_VERSION must equal the released spec version this build pins ` +
        `("${SPEC_VERSION}"), received ${raw.SUAS_SPEC_VERSION === undefined ? '<unset>' : `"${raw.SUAS_SPEC_VERSION}"`}. ` +
        `ENVIRONMENT.md §3 rule 1.`,
    });
  }

  // ENVIRONMENT.md §3 rule 2 / §5 "release manifest ... mismatch".
  if (raw.SUAS_RELEASE_MANIFEST !== RELEASE_MANIFEST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `SUAS_RELEASE_MANIFEST must identify the manifest this build claims ` +
        `("${RELEASE_MANIFEST}"), received ${raw.SUAS_RELEASE_MANIFEST === undefined ? '<unset>' : `"${raw.SUAS_RELEASE_MANIFEST}"`}. ` +
        `ENVIRONMENT.md §3 rule 2.`,
    });
  }

  // ENVIRONMENT.md §3 rules 3-4 / §5 "real external effects enabled outside an
  // authorized production release". Rule 4 keeps this invalid even in PRODUCTION
  // until SPEC-018 makes production operation ready.
  if (raw.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS) {
    const reason =
      environment === 'PRODUCTION'
        ? `production operation is not authorized until SPEC-018 (ENVIRONMENT.md §3 rule 4)`
        : `real external effects are invalid outside PRODUCTION (ENVIRONMENT.md §3 rule 3)`;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=true is rejected in ${environment}: ${reason}.`,
    });
  }

  // HANDOFF.md §2 "Production deployment: prohibited";
  // RELEASE_MANIFEST-0.2.0.md "Readiness boundary".
  if (environment === 'PRODUCTION' && !SPEC_018_PRODUCTION_AUTHORIZED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'SUAS_ENV=PRODUCTION is rejected: production deployment is prohibited until SPEC-018 ' +
        'records launch-readiness evidence (HANDOFF.md §2; RELEASE_MANIFEST-0.2.0.md "Readiness boundary").',
    });
  }

  // ENVIRONMENT.md §5 "required secrets are absent for an enabled capability".
  // Persistence is the only capability enabled in Slice 1; later slices extend this.
  const persistenceEnabled = raw.SUAS_MIGRATIONS_MODE !== 'off';
  if (persistenceEnabled && raw.DATABASE_URL === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'DATABASE_URL is required when SUAS_MIGRATIONS_MODE is "validate" or "apply" ' +
        '(ENVIRONMENT.md §3 "Data / persistence", §5 required-secrets rule).',
    });
  }

  if (raw.DATABASE_URL !== undefined) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(raw.DATABASE_URL);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DATABASE_URL is not a parseable connection URL.',
      });
    }
    if (parsed !== undefined && !['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `DATABASE_URL must use a postgresql:// scheme; PostgreSQL is the logical system of ` +
          `record (ARCHITECTURE.md §3 invariant 2). Received scheme "${parsed.protocol}".`,
      });
    }

    // ENVIRONMENT.md §5 "LOCAL/TEST/STAGING points at known production data resources";
    // §3 "No application startup may silently point LOCAL/TEST/STAGING at a production database."
    if (SYNTHETIC_ONLY_ENVIRONMENTS.includes(environment)) {
      const markers = productionDataMarkersIn(raw.DATABASE_URL);
      if (markers.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `DATABASE_URL host/database name contains production marker(s) ${markers.map((m) => `"${m}"`).join(', ')} ` +
            `while SUAS_ENV=${environment}. LOCAL/TEST/STAGING must not point at production data resources ` +
            `(ENVIRONMENT.md §3 "Data / persistence", §5).`,
        });
      }
    }
  }

  validateDatabaseSsl(raw, ctx);

  // ENVIRONMENT.md §5 "required secrets are absent for an enabled capability".
  // Authentication became an enabled capability in SPEC017_PLAN.md Slice 3, and it
  // keys challenge and session credential hashing, so the secret is now required
  // in every environment class rather than only where sessions are shared.
  if (raw.SUAS_SESSION_SECRET === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `SUAS_SESSION_SECRET is required in ${environment}: authentication is an enabled ` +
        `capability and it keys challenge and session credential hashing. It must come from ` +
        `environment or platform secret storage, never a committed file ` +
        `(ENVIRONMENT.md §3 "Auth / sessions", §5, §6).`,
    });
  } else if (raw.SUAS_SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `SUAS_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters ` +
        `(ENVIRONMENT.md §6 secret classes).`,
    });
  }

  // Also the tenant that new addresses sign up into over /api/v0, so a bad value fails at startup
  // in every mode.
  if (
    raw.SUAS_BROWSER_TENANT_ID !== undefined &&
    !z.string().uuid().safeParse(raw.SUAS_BROWSER_TENANT_ID).success
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'SUAS_BROWSER_TENANT_ID must be a UUID.',
    });
  }

  if (raw.SUAS_BROWSER_AUTH_MODE === 'email_otp') {
    if (raw.SUAS_BROWSER_TENANT_ID === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SUAS_BROWSER_TENANT_ID is required when SUAS_BROWSER_AUTH_MODE=email_otp.',
      });
    }
    if (raw.SUAS_EMAIL_MODE === 'disabled') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Browser EMAIL OTP requires an available EMAIL mode.',
      });
    }
  }

  if (raw.SUAS_EMAIL_MODE === 'resend') {
    if (environment === 'LOCAL' || environment === 'TEST') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `SUAS_EMAIL_MODE=resend is forbidden in ${environment}; use fake or sink.`,
      });
    }
    if (raw.RESEND_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RESEND_API_KEY is required when SUAS_EMAIL_MODE=resend.',
      });
    }
    if (raw.SUAS_EMAIL_FROM === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SUAS_EMAIL_FROM is required when SUAS_EMAIL_MODE=resend.',
      });
    }
  }

  validateAwsCapabilities(raw, environment, ctx);
  validateVaConfirmation(raw, environment, ctx);

  // The sender is required in Resend and SES modes. Both accept either a bare
  // address or the standard display-name form: "Name <address>".
  if (
    raw.SUAS_EMAIL_FROM !== undefined &&
    !/^(?:[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+|[^<>\r\n]+\s<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>)$/.test(
      raw.SUAS_EMAIL_FROM,
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'SUAS_EMAIL_FROM must be an email address or display-name sender when set. Leave it empty in committed files.',
    });
  }
});

/**
 * TLS is configured in one place. A URL that also carries ssl* parameters would
 * silently override these settings (node-postgres lets the URL win), so that
 * combination is refused rather than guessed.
 */
function validateDatabaseSsl(raw: z.infer<typeof rawConfigSchema>, ctx: z.RefinementCtx): void {
  const mode = raw.DATABASE_SSL_MODE;
  if (mode !== undefined && !(DATABASE_SSL_MODES as readonly string[]).includes(mode)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `DATABASE_SSL_MODE must be one of ${DATABASE_SSL_MODES.join(', ')}; received "${mode}".`,
    });
    return;
  }
  if (raw.DATABASE_SSL_CA_FILE !== undefined && mode !== 'verify') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DATABASE_SSL_CA_FILE requires DATABASE_SSL_MODE=verify.',
    });
  }
  if (mode === 'verify' && raw.DATABASE_URL !== undefined) {
    let params: URLSearchParams | undefined;
    try {
      params = new URL(raw.DATABASE_URL).searchParams;
    } catch {
      return; // DATABASE_URL reports its own parse error.
    }
    const conflicting = [...params.keys()].filter(
      (key) => key.startsWith('ssl') || key === 'uselibpqcompat',
    );
    if (conflicting.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `DATABASE_URL must not carry ${conflicting.join(', ')} when DATABASE_SSL_MODE=verify; ` +
          `configure TLS with DATABASE_SSL_MODE and DATABASE_SSL_CA_FILE only.`,
      });
    }
  }
}

/** Shape the validated raw record into the application configuration object. */
export function shapeConfig(
  raw: z.infer<typeof rawConfigSchema>,
  ctx: z.RefinementCtx,
): SuasConfig {
  return {
    environment: raw.SUAS_ENV,
    specVersion: SPEC_VERSION,
    releaseManifest: RELEASE_MANIFEST,
    allowRealExternalEffects: raw.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS,
    database: {
      url: raw.DATABASE_URL,
      // ENVIRONMENT.md §3: the pool must be bounded. The exact production value
      // remains release/operations evidence, so no production default is invented.
      poolMax: parsePositiveInt(
        'DATABASE_POOL_MAX',
        raw.DATABASE_POOL_MAX,
        5,
        { min: 1, max: 100 },
        ctx,
      ),
      migrationsMode: raw.SUAS_MIGRATIONS_MODE,
      resetAllowlist: splitCsv(raw.SUAS_MIGRATION_RESET_ALLOWLIST),
      resetSyntheticMarker: raw.SUAS_MIGRATION_RESET_SYNTHETIC_MARKER,
      ssl: {
        mode: (raw.DATABASE_SSL_MODE ?? 'disable') as DatabaseSslMode,
        caFile: raw.DATABASE_SSL_CA_FILE,
      },
    },
    sessionSecret: raw.SUAS_SESSION_SECRET,
    browserAuth: {
      mode: raw.SUAS_BROWSER_AUTH_MODE,
      tenantId: raw.SUAS_BROWSER_TENANT_ID,
    },
    vaSandboxOAuth: {
      enabled: raw.SUAS_VA_SANDBOX_OAUTH_ENABLED === 'true',
      clientId: raw.SUAS_VA_SANDBOX_OAUTH_CLIENT_ID,
      clientSecret: raw.SUAS_VA_SANDBOX_OAUTH_CLIENT_SECRET,
      authorizationEndpoint: raw.SUAS_VA_SANDBOX_OAUTH_AUTHORIZATION_ENDPOINT,
      redirectUri: raw.SUAS_VA_SANDBOX_OAUTH_REDIRECT_URI,
      tokenEndpoint: raw.SUAS_VA_SANDBOX_OAUTH_TOKEN_ENDPOINT,
      statusEndpoint: raw.SUAS_VA_SANDBOX_OAUTH_STATUS_ENDPOINT,
      issuer: raw.SUAS_VA_SANDBOX_OAUTH_ISSUER,
      audience: raw.SUAS_VA_SANDBOX_OAUTH_AUDIENCE,
      jwksJson: raw.SUAS_VA_SANDBOX_OAUTH_JWKS_JSON,
    },
    notifications: {
      email: raw.SUAS_EMAIL_MODE,
      sms: raw.SUAS_SMS_MODE,
      resendApiKey: raw.RESEND_API_KEY,
      emailFrom: raw.SUAS_EMAIL_FROM,
    },
    aws: { region: raw.SUAS_AWS_REGION },
    modelInference: {
      mode: raw.SUAS_MODEL_INFERENCE_MODE,
      bedrockModelId: raw.SUAS_BEDROCK_MODEL_ID,
    },
    objectStorage: { mode: raw.SUAS_OBJECT_STORAGE_MODE, bucket: raw.SUAS_S3_BUCKET },
    idVerification: { mode: raw.SUAS_ID_VERIFICATION_MODE },
    vaConfirmation: {
      mode: raw.SUAS_VA_CONFIRMATION_MODE,
      baseUrl: raw.SUAS_VA_CONFIRMATION_BASE_URL,
      apiKey: raw.SUAS_VA_CONFIRMATION_API_KEY,
    },
    publicSignUp: raw.SUAS_PUBLIC_SIGN_UP === 'enabled',
    stagingAuthEmails: splitCsv(raw.SUAS_STAGING_AUTH_EMAILS).map((email) => email.toLowerCase()),
    stagingFixturePrincipals: parseStagingFixtureRegistry(raw.SUAS_STAGING_FIXTURE_REGISTRY)
      .principals,
    chatPush: {
      mode: raw.SUAS_CHAT_PUSH_MODE,
      apiGatewayEndpoint: raw.SUAS_CHAT_WS_ENDPOINT,
      publicUrl: raw.SUAS_CHAT_WS_PUBLIC_URL,
      localPort: parsePositiveInt(
        'SUAS_CHAT_LOCAL_WS_PORT',
        raw.SUAS_CHAT_LOCAL_WS_PORT,
        3001,
        { min: 0, max: 65535 },
        ctx,
      ),
    },
    adapters: {
      transportation: raw.SUAS_TRANSPORTATION_ADAPTER_MODE,
      shelter: raw.SUAS_SHELTER_ADAPTER_MODE,
      food: raw.SUAS_FOOD_ADAPTER_MODE,
      peerSupport: raw.SUAS_PEER_SUPPORT_ADAPTER_MODE,
      uberGuestRides: {
        clientId: raw.SUAS_UBER_GUEST_RIDES_CLIENT_ID,
        clientSecret: raw.SUAS_UBER_GUEST_RIDES_CLIENT_SECRET,
        tokenUrl: raw.SUAS_UBER_GUEST_RIDES_TOKEN_URL,
        apiBaseUrl: raw.SUAS_UBER_GUEST_RIDES_API_BASE_URL,
        webhookSecret: raw.SUAS_UBER_GUEST_RIDES_WEBHOOK_SECRET,
      },
      amadeusLodging: {
        clientId: raw.SUAS_AMADEUS_LODGING_CLIENT_ID,
        clientSecret: raw.SUAS_AMADEUS_LODGING_CLIENT_SECRET,
        tokenUrl: raw.SUAS_AMADEUS_LODGING_TOKEN_URL,
        apiBaseUrl: raw.SUAS_AMADEUS_LODGING_API_BASE_URL,
      },
    },
    supportSignalMode: raw.SUAS_SUPPORT_SIGNAL_MODE,
    safetyCopyMode: raw.SUAS_SAFETY_COPY_MODE,
    sensitiveAggregateReporting: raw.SUAS_SENSITIVE_AGGREGATE_REPORTING,
    http: {
      host: raw.SUAS_HTTP_HOST ?? '127.0.0.1',
      port: parsePositiveInt(
        'SUAS_HTTP_PORT',
        raw.SUAS_HTTP_PORT,
        3000,
        { min: 0, max: 65535 },
        ctx,
      ),
    },
    logLevel: resolveLogLevel(raw.SUAS_LOG_LEVEL, raw.SUAS_ENV, ctx),
    demoFixedCode:
      (raw.SUAS_ENV === 'LOCAL' || raw.SUAS_ENV === 'STAGING') &&
      raw.SUAS_DEMO_FIXED_CODE === 'enabled',
    corsAllowedOrigins: parseAllowedOrigins(raw.SUAS_CORS_ALLOWED_ORIGINS, raw.SUAS_ENV).origins,
  };
}

function resolveLogLevel(
  raw: string | undefined,
  environment: EnvironmentClass,
  ctx: z.RefinementCtx,
): LogLevel {
  const fallback: LogLevel = environment === 'TEST' ? 'silent' : 'info';
  if (raw === undefined) return fallback;
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `SUAS_LOG_LEVEL="${raw}" is invalid. Allowed: ${LOG_LEVELS.join(' | ')}.`,
    });
    return fallback;
  }
  return raw as LogLevel;
}

export const suasConfigSchema = configSchema.transform(shapeConfig);
