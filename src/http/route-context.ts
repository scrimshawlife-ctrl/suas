import type { Pool } from 'pg';

/** What every route module needs: the database and the session-signing secret. */
export interface RouteContext {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}
