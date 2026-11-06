#!/usr/bin/env node
/**
 * CDK app entry. Nothing here reads from AWS: the account comes from CDK_DEFAULT_ACCOUNT
 * at deploy time, the region is fixed, and no context lookup is used.
 */

import { App } from 'aws-cdk-lib';
import { createStagingApp } from '../lib/staging.js';

createStagingApp(new App());
