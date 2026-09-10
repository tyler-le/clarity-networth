#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const service = 'clarity-networth';
const environment = {
  name: 'development',
  railwayEnvironment: 'staging',
  healthUrl: 'https://clarity-networth-staging.up.railway.app/api/health',
};

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

async function waitForHealth(url, name) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (response.ok && body?.ok === true) return;
    } catch {
      // A deploy can cold-start. Retry below rather than failing the release.
    }
    if (attempt === 12) throw new Error(`${name} did not become healthy: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

const message = `Local development deploy ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}`;

console.log('Deploying to development without a test gate…');
run('railway', ['up', '--service', service, '--environment', environment.railwayEnvironment, '--ci', '--message', message]);
console.log('Checking development health…');
await waitForHealth(environment.healthUrl, environment.name);

console.log('Development is healthy. Production can only deploy through the manual deploy-to-prod GitHub Action.');
