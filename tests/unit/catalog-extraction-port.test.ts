import { describe, expect, it } from 'vitest';
import type { EnvironmentClass } from '../../src/config/index.js';
import { catalogExtractionPort } from '../../src/http/server.js';
import { ScriptedModelInference, UnavailableModelInference } from '../../src/inference/index.js';

// R17.6 (contributor's call, not released): the catalog builder stays off on STAGING.
describe('catalogExtractionPort', () => {
  it('is unavailable on STAGING even with a model configured', () => {
    const port = catalogExtractionPort('STAGING', new ScriptedModelInference());
    expect(port).toBeInstanceOf(UnavailableModelInference);
  });

  it('passes the configured model through in LOCAL and TEST', () => {
    const model = new ScriptedModelInference();
    expect(catalogExtractionPort('LOCAL', model)).toBe(model);
    expect(catalogExtractionPort('TEST', model)).toBe(model);
  });

  // R17.x (contributor's call, D-064): allow-only, so PRODUCTION and unknown values are refused.
  it.each(['PRODUCTION', 'staging', 'DEMO'])('is unavailable for %s', (environment) => {
    const port = catalogExtractionPort(
      environment as EnvironmentClass,
      new ScriptedModelInference(),
    );
    expect(port).toBeInstanceOf(UnavailableModelInference);
  });

  it('is unavailable when no model is configured', () => {
    expect(catalogExtractionPort('TEST', undefined)).toBeInstanceOf(UnavailableModelInference);
  });
});
