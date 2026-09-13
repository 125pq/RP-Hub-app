import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const override = process.env.RPHUB_TEST_WEB_ROOT;
if (override !== undefined && !override.trim()) throw new Error('RPHUB_TEST_WEB_ROOT must name an explicit directory');
export const webFixtureRoot = override === undefined ? repository : path.resolve(override);

// An explicit candidate never falls back to checkout assets if a file is missing.
export function webFixturePath(relative) {
  const result = path.resolve(webFixtureRoot, relative);
  const child = path.relative(webFixtureRoot, result);
  if (!child || child === '..' || child.startsWith('..' + path.sep) || path.isAbsolute(child)) {
    throw new Error('Web fixture path escapes its selected root: ' + relative);
  }
  return result;
}
