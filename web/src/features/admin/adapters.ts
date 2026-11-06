import type { AdapterCatalogEntry } from './api';
import { CATEGORY_LABELS } from './labels';
import type { ServiceCategory } from '../../api/types';

const MODES: Record<string, string> = {
  MANUAL_COORDINATION: 'Manual coordination',
  API: 'API adapter',
};

const CREDENTIALS: Record<string, string> = {
  NOT_REQUIRED: 'not required',
  CONFIGURED: 'configured',
  MISSING: 'missing',
};

/** Words for a catalog value; an unknown value is shown as the API sent it. */
export const modeWords = (mode: string) => MODES[mode] ?? mode;
export const credentialWords = (presence: string) => CREDENTIALS[presence] ?? presence;

export function capabilityWords(capability: string): string {
  return CATEGORY_LABELS[capability as ServiceCategory] ?? capability;
}

export function decisionWords(decision: string): string {
  return decision === 'ALWAYS' ? 'Always available' : `Decision ${decision}`;
}

export type { AdapterCatalogEntry };
