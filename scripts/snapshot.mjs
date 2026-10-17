import { appendFileSync, readFileSync } from 'node:fs';
import { parseImage } from './runtime.mjs';
const [app, expected = ''] = process.argv.slice(2);
const release = parseImage(app, readFileSync(`apps/${app}/image.env`, 'utf8'));
if (expected && expected !== release.image) throw new Error('Requested image differs from triggering commit');
appendFileSync(process.env.GITHUB_OUTPUT, `image=${release.image}\n`);
