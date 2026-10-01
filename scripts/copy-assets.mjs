import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'dist');

mkdirSync(target, { recursive: true });
copyFileSync(join(root, 'src', 'openapi.json'), join(target, 'openapi.json'));
process.stderr.write('copied src/openapi.json -> dist/openapi.json\n');
