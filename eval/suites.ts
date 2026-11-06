/** Every suite `npm run eval` runs. Add a suite here (see harness.ts). */

import type { RunnableSuite } from './harness.js';
import { intakeSuite } from './intake/suite.js';

export const SUITES: readonly RunnableSuite[] = [intakeSuite];
