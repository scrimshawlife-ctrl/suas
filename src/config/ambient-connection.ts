/**
 * libpq and the process DATABASE_URL, read at the moment of a reset.
 *
 * These are not released configuration variables. They can redirect a Postgres
 * client that does not pin every connection field, so the reset reads them here
 * and refuses when they disagree with the authorized target.
 */

export interface AmbientConnectionEnv {
  readonly DATABASE_URL: string | undefined;
  readonly PGHOST: string | undefined;
  readonly PGPORT: string | undefined;
  readonly PGUSER: string | undefined;
  readonly PGPASSWORD: string | undefined;
  readonly PGDATABASE: string | undefined;
}

export function ambientConnectionEnv(): AmbientConnectionEnv {
  return {
    DATABASE_URL: process.env.DATABASE_URL,
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
    PGUSER: process.env.PGUSER,
    PGPASSWORD: process.env.PGPASSWORD,
    PGDATABASE: process.env.PGDATABASE,
  };
}
