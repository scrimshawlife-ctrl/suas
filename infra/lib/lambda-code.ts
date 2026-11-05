/**
 * The Lambda deployment package: one directory shared by the four functions.
 *
 * esbuild bundles each entry point from the repository's `src/` into `<name>.mjs` at
 * synth time, using the esbuild binary from this package's node_modules. It never starts
 * Docker; if bundling fails the synth fails (there is no container fallback). The
 * directory also carries what the code reads from disk at run time:
 *   - `package.json`   (src/provenance/build-info.ts resolves the app version beside the bundle)
 *   - `migrations/`    (src/db/migration-files.ts resolves it beside the bundle)
 *   - `run.sh`         (Lambda Web Adapter entry for the API function)
 *   - `rds-global-bundle.crt` (public RDS CA bundle, for the migrate function's direct TLS connection)
 */

import { cpSync, chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { AssetHashType, DockerImage } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const infraDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(infraDir, '..');

/** Bundle name to its entry file in the repository. */
export const ENTRY_POINTS = {
  api: 'src/main.ts',
  websocket: 'src/aws/websocket-lambda.ts',
  'job-worker': 'src/aws/job-worker-lambda.ts',
  migrate: 'src/aws/migrate-lambda.ts',
} as const;

export const RDS_CA_BUNDLE_FILE = 'rds-global-bundle.crt';

function bundleInto(outputDir: string): void {
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: Object.fromEntries(
      Object.entries(ENTRY_POINTS).map(([name, entry]) => [name, path.join(repoRoot, entry)]),
    ),
    outdir: outputDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // The AWS SDK is bundled, not taken from the Lambda runtime, so the version in
    // package-lock.json is the version that runs.
    // CommonJS dependencies (pg, fastify) call require() on Node built-ins.
    banner: {
      js: "import { createRequire as __suasCreateRequire } from 'node:module';\nconst require = __suasCreateRequire(import.meta.url);",
    },
    legalComments: 'none',
    logLevel: 'warning',
  });
  copyFileSync(path.join(repoRoot, 'package.json'), path.join(outputDir, 'package.json'));
  cpSync(path.join(repoRoot, 'migrations'), path.join(outputDir, 'migrations'), {
    recursive: true,
  });
  copyFileSync(path.join(infraDir, 'lambda', 'run.sh'), path.join(outputDir, 'run.sh'));
  chmodSync(path.join(outputDir, 'run.sh'), 0o755);
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(
    path.join(infraDir, 'assets', RDS_CA_BUNDLE_FILE),
    path.join(outputDir, RDS_CA_BUNDLE_FILE),
  );
}

/** Code for all four functions. Create it once per stack so there is one asset. */
export function suasLambdaCode(): lambda.Code {
  return lambda.Code.fromAsset(path.join(infraDir, 'lambda'), {
    // Hash what was produced, not the (huge) repository the bundle was built from.
    assetHashType: AssetHashType.OUTPUT,
    bundling: {
      // Never used: `local` always either succeeds or throws.
      image: DockerImage.fromRegistry('scratch'),
      local: {
        tryBundle(outputDir: string): boolean {
          bundleInto(outputDir);
          return true;
        },
      },
    },
  });
}
