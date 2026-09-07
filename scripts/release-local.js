#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

// This flag exists only in Codex's restricted shell. A local release must
// never treat that environment-specific limitation as permission to skip its
// browser or integration coverage.
delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;

const service = 'clarity-networth';
const environments = [
  { name: 'staging', healthUrl: 'https://clarity-networth-staging.up.railway.app/api/health' },
  { name: 'production', healthUrl: 'https://claritynetworth.com/api/health' },
];

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

const message = `Local release ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}`;

console.log('Running local release verification…');
run('npm', ['run', 'test:local']);
run('npm', ['run', 'test:ui:critical']);

for (const environment of environments) {
  console.log(`Deploying to ${environment.name}…`);
  run('railway', ['up', '--service', service, '--environment', environment.name, '--ci', '--message', message]);
  console.log(`Checking ${environment.name} health…`);
  await waitForHealth(environment.healthUrl, environment.name);
}

console.log('Staging and production are healthy. Release complete.');
