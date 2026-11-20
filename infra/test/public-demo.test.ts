/**
 * R16.1, R16.2 (contributor proposal, not released): `-c publicDemo=true` sets SUAS_PUBLIC_DEMO on
 * the API, worker, migrate and relay functions and throttles the sign-in challenge routes. Off,
 * the template carries none of it. Offline, against the in-memory templates.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { synthesize, type Synthesized } from './helpers.js';

type Resource = { Type: string; Properties?: Record<string, any> };
type Template = Synthesized['backend'];
const ofType = (t: Template, type: string): Resource[] =>
  Object.values(t.toJSON().Resources as Record<string, Resource>).filter((r) => r.Type === type);
const demoHandlers = (t: Template): string[] =>
  ofType(t, 'AWS::Lambda::Function')
    .filter((fn) => fn.Properties?.Environment?.Variables?.SUAS_PUBLIC_DEMO === 'enabled')
    .map((fn) => String(fn.Properties?.Handler))
    .sort();
const stage = (t: Template) => ofType(t, 'AWS::ApiGatewayV2::Stage')[0]?.Properties;
const routeKeys = (t: Template) =>
  ofType(t, 'AWS::ApiGatewayV2::Route').map((r) => String(r.Properties?.RouteKey));

let off: Synthesized;
let on: Synthesized;
beforeAll(() => {
  off = synthesize();
  on = synthesize({ publicDemo: 'true' });
});

describe('public demo deploy switch', () => {
  it('adds nothing by default: no SUAS_PUBLIC_DEMO, no route settings, only $default', () => {
    expect(demoHandlers(off.backend)).toEqual([]);
    for (const fn of ofType(off.backend, 'AWS::Lambda::Function')) {
      expect(Object.keys(fn.Properties?.Environment?.Variables ?? {})).not.toContain(
        'SUAS_PUBLIC_DEMO',
      );
    }
    expect(stage(off.backend)).not.toHaveProperty('RouteSettings');
    expect(routeKeys(off.backend)).toEqual(['$default']);
  });

  it('sets SUAS_PUBLIC_DEMO=enabled on the api, worker, migrate and relay functions', () => {
    expect(demoHandlers(on.backend)).toEqual([
      'email-relay.handler',
      'job-worker.handler',
      'migrate.handler',
      'run.sh',
    ]);
  });

  // Every route that issues a sign-in challenge (src/http/routes/auth.ts and ui.ts).
  it('throttles every challenge-issuing route at 2 rps, burst 5, and keeps the stage at 50/100', () => {
    const challengeRoutes = ['POST /api/v0/auth/challenges', 'POST /app/auth/challenges'];
    expect(routeKeys(on.backend).sort()).toEqual(['$default', ...challengeRoutes].sort());
    const settings = stage(on.backend)?.RouteSettings as Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual([...challengeRoutes].sort());
    for (const key of challengeRoutes) {
      expect(settings[key]).toEqual({ ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 });
    }
    expect(stage(on.backend)?.DefaultRouteSettings).toEqual({
      ThrottlingBurstLimit: 100,
      ThrottlingRateLimit: 50,
    });
  });
});
