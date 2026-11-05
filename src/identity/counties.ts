/**
 * Launch counties.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "County" and "Widening": a person picks one of seven
 *   counties at sign-up, and an unaccepted request widens to bordering counties.
 *
 * The values match the `suas_county` database enum. Bordering counties are rows in
 * `county_adjacency`, not a constant here, so the database is the one source.
 */

import type { Queryable } from '../db/transaction.js';

export const SERVICE_COUNTIES = [
  'SANTA_CLARA',
  'SAN_MATEO',
  'ALAMEDA',
  'SANTA_CRUZ',
  'SAN_BENITO',
  'MERCED',
  'STANISLAUS',
] as const;
export type ServiceCounty = (typeof SERVICE_COUNTIES)[number];

/** Counties that share a land border with `county`, from the seeded adjacency table. */
export async function listBorderingCounties(
  db: Queryable,
  county: ServiceCounty,
): Promise<ServiceCounty[]> {
  const result = await db.query<{ adjacent_county: ServiceCounty }>(
    `SELECT adjacent_county FROM county_adjacency WHERE county = $1 ORDER BY adjacent_county`,
    [county],
  );
  return result.rows.map((row) => row.adjacent_county);
}
