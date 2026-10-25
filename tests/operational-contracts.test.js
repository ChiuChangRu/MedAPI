import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('all three active Workers preserve their production identities and secrets', () => {
  const contracts = [
    ['cloudflare/wrangler.jsonc', 'medtec-2026'],
    ['fieldlog/wrangler.jsonc', 'fieldlog'],
    ['mcp/wrangler.jsonc', 'medapi-mcp'],
  ];

  for (const [path, workerName] of contracts) {
    const config = read(path);
    assert.match(config, new RegExp(`"name"\\s*:\\s*"${workerName}"`), `${path} must keep the production Worker name`);
    assert.match(config, /"keep_vars"\s*:\s*true/, `${path} must preserve Dashboard variables and secrets`);
  }
});

test('MyWiki keeps fieldlog and MCP as separate, connected Workers', () => {
  const fieldlog = read('fieldlog/wrangler.jsonc');
  const mcp = read('mcp/wrangler.jsonc');

  assert.match(fieldlog, /"binding"\s*:\s*"DB"/);
  assert.match(fieldlog, /"binding"\s*:\s*"FILES"/);
  assert.match(fieldlog, /"binding"\s*:\s*"MEDTEC"/);
  assert.match(mcp, /"binding"\s*:\s*"DB_FIELDLOG"/);
  assert.match(mcp, /"binding"\s*:\s*"DB_MEDTEC"/);
  assert.match(mcp, /"binding"\s*:\s*"FIELDLOG"\s*,\s*"service"\s*:\s*"fieldlog"/);
  assert.match(mcp, /"binding"\s*:\s*"MEDTEC"\s*,\s*"service"\s*:\s*"medtec-2026"/);
});

test('validation continues to cover every active Worker', () => {
  const pkg = JSON.parse(read('package.json'));
  const validate = pkg.scripts.validate;

  assert.match(validate, /npm run validate:fieldlog/);
  assert.match(validate, /npm run validate:medtec/);
  assert.match(validate, /npm run validate:mcp/);
});

test('medtec production deployment remains pinned and main-only', () => {
  const workflow = read('.github/workflows/deploy.yml');

  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.match(workflow, /wranglerVersion:\s*["']4\.120\.1["']/);
  assert.match(workflow, /workingDirectory:\s*cloudflare/);
});
