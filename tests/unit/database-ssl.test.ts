/**
 * Database TLS configuration (DATABASE_SSL_MODE, DATABASE_SSL_CA_FILE).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { databaseClientSettings, databaseSslOptions } from '../../src/db/pool.js';
import { validEnv } from '../helpers/env.js';

function issuesFor(env: Record<string, string | undefined>): readonly string[] {
  const result = tryLoadConfig(validEnv(env));
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? [] : result.issues;
}

describe('database TLS configuration', () => {
  it('defaults to no TLS so LOCAL and TEST keep working', () => {
    const { ssl } = loadConfig(validEnv()).database;
    expect(ssl).toEqual({ mode: 'disable', caFile: undefined });
    expect(databaseSslOptions(ssl)).toBeUndefined();
  });

  it('gives the Worker client the same verify TLS settings as the Node pool', () => {
    const verify = loadConfig(validEnv({ DATABASE_SSL_MODE: 'verify' }));
    expect(databaseClientSettings(verify).ssl).toEqual({ rejectUnauthorized: true });
    const plain = loadConfig(validEnv());
    expect(databaseClientSettings(plain).ssl).toBeUndefined();
  });

  it('verify mode checks the server certificate and uses the default trust store', () => {
    const { ssl } = loadConfig(validEnv({ DATABASE_SSL_MODE: 'verify' })).database;
    expect(databaseSslOptions(ssl)).toEqual({ rejectUnauthorized: true });
  });

  it('verify mode trusts the CA bundle at the configured path', () => {
    const { ssl } = loadConfig(
      validEnv({ DATABASE_SSL_MODE: 'verify', DATABASE_SSL_CA_FILE: '/var/task/rds-bundle.pem' }),
    ).database;
    const reads: string[] = [];
    const options = databaseSslOptions(ssl, (path) => {
      reads.push(path);
      return 'PEM-BUNDLE';
    });
    expect(options).toEqual({ rejectUnauthorized: true, ca: 'PEM-BUNDLE' });
    expect(reads).toEqual(['/var/task/rds-bundle.pem']);
  });

  it('rejects an unknown mode, since unverified TLS is not offered', () => {
    expect(issuesFor({ DATABASE_SSL_MODE: 'no-verify' }).join('\n')).toMatch(/DATABASE_SSL_MODE/);
  });

  it('rejects a CA file without verify mode', () => {
    expect(issuesFor({ DATABASE_SSL_CA_FILE: '/x.pem' }).join('\n')).toMatch(
      /DATABASE_SSL_CA_FILE requires DATABASE_SSL_MODE=verify/,
    );
  });

  it('rejects ssl parameters in DATABASE_URL that would override verify mode', () => {
    const issues = issuesFor({
      DATABASE_SSL_MODE: 'verify',
      DATABASE_URL: 'postgresql://suas:suas@localhost:5432/suas_test?sslmode=disable',
    });
    expect(issues.join('\n')).toMatch(/must not carry sslmode/);
  });
});

// Review of #325: `verify` checks the host name as well as the chain, as libpq's verify-full.
// openssl makes a throwaway CA and certificates; the server only answers pg's SSLRequest.
describe('verify mode against a TLS server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suas-db-tls-'));
  // Arguments are split on spaces, so none may contain one.
  const openssl = (command: string) =>
    execFileSync('openssl', command.split(' '), { cwd: dir, stdio: 'ignore' });
  const issue = (name: string, host: string, ca: string) => {
    openssl(`req -newkey rsa:2048 -nodes -keyout ${name}.key -out ${name}.csr -subj /CN=${host}`);
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=DNS:${host}\n`);
    openssl(
      `x509 -req -in ${name}.csr -CA ${ca}.crt -CAkey ${ca}.key -CAcreateserial ` +
        `-out ${name}.crt -days 1 -extfile ${name}.ext`,
    );
  };
  beforeAll(() => {
    for (const ca of ['trusted', 'other']) {
      openssl(
        `req -x509 -newkey rsa:2048 -nodes -keyout ${ca}.key -out ${ca}.crt -days 1 -subj /CN=${ca}-ca`,
      );
    }
    issue('right-host', 'localhost', 'trusted');
    issue('wrong-host', 'db.elsewhere.invalid', 'trusted');
    issue('untrusted', 'localhost', 'other');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The error code pg reports, or 'past TLS' when the handshake passed and the server hung up.
  async function connectTo(certificate: string): Promise<string> {
    const read = (ext: string) => readFileSync(join(dir, `${certificate}.${ext}`));
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write('S');
        const secure = new TLSSocket(socket, {
          isServer: true,
          key: read('key'),
          cert: read('crt'),
        });
        secure.on('error', () => {});
        secure.on('secure', () => secure.end());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new Client({
      connectionString: `postgresql://suas:suas@localhost:${String(port)}/suas`,
      ssl: databaseSslOptions({ mode: 'verify', caFile: join(dir, 'trusted.crt') }),
    });
    client.on('error', () => {});
    try {
      await client.connect();
      return 'connected';
    } catch (error) {
      return (error as { code?: string }).code ?? 'past TLS';
    } finally {
      server.close();
    }
  }

  it('accepts a certificate from the bundle for the host it dials', async () => {
    expect(await connectTo('right-host')).toBe('past TLS');
  });

  it('refuses a certificate from the bundle issued for another host', async () => {
    expect(await connectTo('wrong-host')).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('refuses a certificate from a CA outside the bundle', async () => {
    expect(await connectTo('untrusted')).toMatch(
      /^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/,
    );
  });
});
