import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpenApiDocument } from '../src/docs/openapi.js';

// `npm run docs:lint`: writes the generated spec to a temp file and runs
// `redocly lint` on it with the repo's redocly.yaml. Building the document only
// loads Zod schemas (no env or DB), so this needs no .env.
const dir = mkdtempSync(join(tmpdir(), 'storeforge-openapi-'));
const file = join(dir, 'openapi.json');
writeFileSync(file, JSON.stringify(buildOpenApiDocument(), null, 2));

const result = spawnSync('redocly', ['lint', file, '--config', 'redocly.yaml'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 1);
