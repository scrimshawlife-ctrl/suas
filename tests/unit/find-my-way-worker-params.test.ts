import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Guards the patched find-my-way params codegen fallback.
 *
 * Cloudflare Workers disallow runtime code generation, so the patched
 * `_compileCreateParamsObject` throws under `wrangler dev`. The old fallback returned `null`,
 * which dropped every path param (for example `:caseId`) and made parameterised `/api/v0` routes
 * answer 400. The fixed fallback builds the params object by hand, without codegen.
 */
const require = createRequire(import.meta.url);

const HandlerStorage = require('find-my-way/lib/handler-storage.js') as new () => {
  _compileCreateParamsObject(params: string[]): (values: string[]) => Record<string, string> | null;
};

const originalFunction = globalThis.Function;

const forbidCodegen = (): void => {
  globalThis.Function = (() => {
    throw new EvalError('Code generation from strings disallowed for this context');
  }) as unknown as FunctionConstructor;
};

afterEach(() => {
  globalThis.Function = originalFunction;
});

describe('find-my-way _compileCreateParamsObject', () => {
  it('maps params to values when codegen is available', () => {
    const storage = new HandlerStorage();
    const createParamsObject = storage._compileCreateParamsObject(['caseId', 'id']);

    const result = createParamsObject(['c-1', 's-2']);

    expect(result).not.toBeNull();
    expect({ ...result }).toEqual({ caseId: 'c-1', id: 's-2' });
  });

  it('maps params to values when codegen is forbidden', () => {
    forbidCodegen();

    const storage = new HandlerStorage();
    const createParamsObject = storage._compileCreateParamsObject(['caseId', 'id']);

    const result = createParamsObject(['c-1', 's-2']);

    expect(result).not.toBeNull();
    expect({ ...result }).toEqual({ caseId: 'c-1', id: 's-2' });
  });

  it('returns an empty object for an empty params list when codegen is forbidden', () => {
    forbidCodegen();

    const storage = new HandlerStorage();
    const createParamsObject = storage._compileCreateParamsObject([]);

    const result = createParamsObject([]);

    expect(result).not.toBeNull();
    expect({ ...result }).toEqual({});
  });
});
