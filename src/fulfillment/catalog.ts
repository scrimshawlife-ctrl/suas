/**
 * Installed adapter catalog — which implementations this build can run.
 *
 * Spec citations:
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §1 (capability ports, replaceable
 *   adapters), §2 rule 1 (no SDKs in domain), rule 8 (manual always available),
 *   rule 10 (vendor names only when a decision records them)
 * - SUAS-specs ADMIN.md §3 (admin enables accepted adapters by tenant/coverage;
 *   enabling without a closed decision is rejected; secrets never appear)
 * - SUAS-specs RELEASE_DECISIONS-0.1.2.md (D-017 Uber), 0.1.3.md (D-018 Amadeus)
 *
 * The catalog is code. Admin cannot invent a new API adapter from the UI.
 * `provider_adapter_configurations` records which catalog entries a tenant may
 * use. Food/peer API adapters are absent until D-019 / D-020 close.
 */

import type { ServiceCategory } from '../coordination/index.js';
import type { SuasConfig } from '../config/index.js';
import type { IntegrationMode } from './port.js';

export const ADAPTER_DECISIONS = ['ALWAYS', 'D-017', 'D-018'] as const;
export type AdapterDecision = (typeof ADAPTER_DECISIONS)[number];

export const SECRET_PRESENCE_STATES = ['NOT_REQUIRED', 'CONFIGURED', 'MISSING'] as const;
export type SecretPresence = (typeof SECRET_PRESENCE_STATES)[number];

export interface AdapterCatalogEntry {
  readonly adapterId: string;
  readonly capability: ServiceCategory;
  readonly integrationMode: IntegrationMode;
  readonly decision: AdapterDecision;
  /** Human-readable label. Not a vendor type in the domain. */
  readonly label: string;
}

/** Capability-specific manuals. PROVIDER_INTEGRATIONS.md §4.0. */
export const MANUAL_ADAPTER_CATALOG: readonly AdapterCatalogEntry[] = [
  {
    adapterId: 'food-manual',
    capability: 'FOOD',
    integrationMode: 'MANUAL_COORDINATION',
    decision: 'ALWAYS',
    label: 'Manual food coordination',
  },
  {
    adapterId: 'transportation-manual',
    capability: 'TRANSPORTATION',
    integrationMode: 'MANUAL_COORDINATION',
    decision: 'ALWAYS',
    label: 'Manual transportation coordination',
  },
  {
    adapterId: 'shelter-manual',
    capability: 'SHELTER',
    integrationMode: 'MANUAL_COORDINATION',
    decision: 'ALWAYS',
    label: 'Manual shelter coordination',
  },
  {
    adapterId: 'peer-support-manual',
    capability: 'PEER_SUPPORT',
    integrationMode: 'MANUAL_COORDINATION',
    decision: 'ALWAYS',
    label: 'Manual peer-support coordination',
  },
];

/** API adapters whose provider decision is closed. */
export const API_ADAPTER_CATALOG: readonly AdapterCatalogEntry[] = [
  {
    adapterId: 'transportation-api',
    capability: 'TRANSPORTATION',
    integrationMode: 'API',
    decision: 'D-017',
    label: 'Transportation API adapter',
  },
  {
    adapterId: 'shelter-api',
    capability: 'SHELTER',
    integrationMode: 'API',
    decision: 'D-018',
    label: 'Temporary-shelter API adapter',
  },
];

export const ADAPTER_CATALOG: readonly AdapterCatalogEntry[] = [
  ...MANUAL_ADAPTER_CATALOG,
  ...API_ADAPTER_CATALOG,
];

export function findCatalogEntry(
  adapterId: string,
  capability: ServiceCategory,
): AdapterCatalogEntry | undefined {
  return ADAPTER_CATALOG.find(
    (entry) => entry.adapterId === adapterId && entry.capability === capability,
  );
}

export function secretPresence(config: SuasConfig, adapterId: string): SecretPresence {
  if (adapterId.endsWith('-manual')) return 'NOT_REQUIRED';
  if (adapterId === 'transportation-api') {
    const uber = config.adapters.uberGuestRides;
    return uber.clientId !== undefined && uber.clientSecret !== undefined
      ? 'CONFIGURED'
      : 'MISSING';
  }
  if (adapterId === 'shelter-api') {
    const lodging = config.adapters.amadeusLodging;
    return lodging.clientId !== undefined && lodging.clientSecret !== undefined
      ? 'CONFIGURED'
      : 'MISSING';
  }
  return 'MISSING';
}

export class AdapterNotAcceptedError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(adapterId: string, capability: string) {
    super(
      `Adapter "${adapterId}" is not an accepted ${capability} adapter in this release ` +
        `(SUAS-specs ADMIN.md §3). Food/peer API adapters stay unavailable until D-019/D-020.`,
    );
    this.name = 'AdapterNotAcceptedError';
  }
}

export class AdapterSecretsMissingError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(adapterId: string) {
    super(
      `Adapter "${adapterId}" cannot be enabled while credentials are MISSING ` +
        `(SUAS-specs ADMIN.md §3).`,
    );
    this.name = 'AdapterSecretsMissingError';
  }
}

export function assertCanEnable(input: {
  readonly adapterId: string;
  readonly capability: ServiceCategory;
  readonly secretPresence: SecretPresence;
}): AdapterCatalogEntry {
  const entry = findCatalogEntry(input.adapterId, input.capability);
  if (entry === undefined) {
    throw new AdapterNotAcceptedError(input.adapterId, input.capability);
  }
  if (entry.integrationMode === 'API' && input.secretPresence === 'MISSING') {
    throw new AdapterSecretsMissingError(input.adapterId);
  }
  return entry;
}
