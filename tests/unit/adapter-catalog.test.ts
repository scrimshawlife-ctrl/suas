/**
 * Installed adapter catalog — ADMIN.md §3 / PROVIDER_INTEGRATIONS.md §4.0.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  ADAPTER_CATALOG,
  AdapterNotAcceptedError,
  AdapterSecretsMissingError,
  assertCanEnable,
  findCatalogEntry,
  MANUAL_ADAPTER_CATALOG,
  secretPresence,
} from '../../src/fulfillment/catalog.js';
import { validEnv } from '../helpers/env.js';

describe('ADAPTER_CATALOG', () => {
  it('installs a mandatory manual adapter for every MVP capability', () => {
    expect(MANUAL_ADAPTER_CATALOG.map((entry) => entry.capability).sort()).toEqual([
      'FOOD',
      'PEER_SUPPORT',
      'SHELTER',
      'TRANSPORTATION',
    ]);
    for (const entry of MANUAL_ADAPTER_CATALOG) {
      expect(entry.integrationMode).toBe('MANUAL_COORDINATION');
      expect(entry.decision).toBe('ALWAYS');
    }
  });

  it('installs closed API adapters for transportation and shelter only', () => {
    const api = ADAPTER_CATALOG.filter((entry) => entry.integrationMode === 'API');
    expect(api.map((entry) => `${entry.capability}:${entry.adapterId}`).sort()).toEqual([
      'SHELTER:shelter-api',
      'TRANSPORTATION:transportation-api',
    ]);
  });

  it('does not install a food or peer API adapter while D-019/D-020 are open', () => {
    expect(findCatalogEntry('food-api', 'FOOD')).toBeUndefined();
    expect(findCatalogEntry('peer-support-api', 'PEER_SUPPORT')).toBeUndefined();
  });
});

describe('assertCanEnable', () => {
  it('accepts a manual adapter with no secrets', () => {
    const entry = assertCanEnable({
      adapterId: 'food-manual',
      capability: 'FOOD',
      secretPresence: 'NOT_REQUIRED',
    });
    expect(entry.adapterId).toBe('food-manual');
  });

  it('rejects an adapter that is not in the catalog', () => {
    expect(() =>
      assertCanEnable({
        adapterId: 'food-api',
        capability: 'FOOD',
        secretPresence: 'CONFIGURED',
      }),
    ).toThrow(AdapterNotAcceptedError);
  });

  it('rejects a capability/id pair that does not match the catalog', () => {
    expect(() =>
      assertCanEnable({
        adapterId: 'transportation-api',
        capability: 'FOOD',
        secretPresence: 'CONFIGURED',
      }),
    ).toThrow(AdapterNotAcceptedError);
  });

  it('rejects an API adapter whose secrets are missing', () => {
    expect(() =>
      assertCanEnable({
        adapterId: 'transportation-api',
        capability: 'TRANSPORTATION',
        secretPresence: 'MISSING',
      }),
    ).toThrow(AdapterSecretsMissingError);
  });

  it('accepts an API adapter when secrets are configured', () => {
    expect(
      assertCanEnable({
        adapterId: 'shelter-api',
        capability: 'SHELTER',
        secretPresence: 'CONFIGURED',
      }).decision,
    ).toBe('D-018');
  });
});

describe('secretPresence', () => {
  it('is NOT_REQUIRED for manuals', () => {
    const config = loadConfig(validEnv());
    expect(secretPresence(config, 'shelter-manual')).toBe('NOT_REQUIRED');
  });

  it('is MISSING for transportation-api without credentials', () => {
    const config = loadConfig(validEnv());
    expect(secretPresence(config, 'transportation-api')).toBe('MISSING');
  });

  it('is CONFIGURED when Uber credentials are present', () => {
    const config = loadConfig(
      validEnv({
        SUAS_UBER_GUEST_RIDES_CLIENT_ID: 'client',
        SUAS_UBER_GUEST_RIDES_CLIENT_SECRET: 'secret',
      }),
    );
    expect(secretPresence(config, 'transportation-api')).toBe('CONFIGURED');
  });
});
