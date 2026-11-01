import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    DEMO_MODE: 'true',
    DATA_DIR: path.join(projectRoot, 'data', 'ui-preview'),
    DATA_ENCRYPTION_KEY: 'local-design-preview-data-only',
    SESSION_SECRET: 'local-design-preview-session-only',
    DATABASE_URL: '',
    PLAID_CLIENT_ID: '',
    PLAID_SECRET: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    STRIPE_SECRET_KEY: ''
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
