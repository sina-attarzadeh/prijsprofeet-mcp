/**
 * Prints the generated MCP tool surface without starting a transport.
 * Run with: npm run inspect
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../dist/config.js';
import { PrijsProfeetClient } from '../dist/client.js';
import { buildTools, NEVER_EXPOSED_ENDPOINTS } from '../dist/tools.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const specPath = [join(root, 'src', 'openapi.json'), join(root, 'dist', 'openapi.json')].find(existsSync);
if (!specPath) throw new Error('openapi.json not found in src/ or dist/');

const config = { ...loadConfig(), specPath };
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const { tools, excluded } = buildTools(spec, new PrijsProfeetClient(config), config.toolPrefix, config.plan);

const asJson = process.argv.includes('--json');

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })), null, 2)}\n`,
  );
} else {
  for (const tool of tools) {
    const required = tool.inputSchema.required ?? [];
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    process.stdout.write(`\n${tool.name}  <-  ${tool.endpoint.id}\n`);
    process.stdout.write(`  args: ${properties.length === 0 ? '(none)' : properties.join(', ')}\n`);
    if (required.length > 0) process.stdout.write(`  required: ${required.join(', ')}\n`);
    const firstLine = tool.description.split('\n')[0];
    process.stdout.write(`  ${firstLine}\n`);
  }
  process.stdout.write(`\n${tools.length} tools (plan: ${config.plan})\n`);
  if (excluded.length > 0) {
    process.stdout.write(`withheld on the ${config.plan} plan: ${excluded.join(', ')}\n`);
  }
  process.stdout.write(`never exposed: ${[...NEVER_EXPOSED_ENDPOINTS].join(', ')}\n`);
}
