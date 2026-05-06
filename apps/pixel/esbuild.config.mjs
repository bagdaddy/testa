import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const outdir = resolve(__dirname, 'dist');
mkdirSync(outdir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2017'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': watch ? '"development"' : '"production"',
  },
};

const builds = [
  {
    name: 'loader',
    entryPoints: [resolve(__dirname, 'src/loader.ts')],
    outfile: resolve(outdir, 'loader.min.js'),
    minify: !watch,
    globalName: '_testaLoader',
  },
  {
    name: 'runtime',
    entryPoints: [resolve(__dirname, 'src/runtime/index.ts')],
    outfile: resolve(outdir, 'runtime.min.js'),
    minify: !watch,
    globalName: '_testaRuntime',
  },
];

function writeManifest() {
  const manifest = {};
  for (const b of builds) {
    try {
      const contents = readFileSync(b.outfile);
      const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12);
      manifest[b.name] = {
        path: b.outfile.replace(`${__dirname}/`, ''),
        bytes: contents.length,
        hash,
      };
    } catch {
      // build hasn't produced output yet
    }
  }
  writeFileSync(resolve(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Strip the metadata `name` field — esbuild rejects it as an unknown option. */
function toEsbuildOptions(b) {
  const { name: _name, ...rest } = b;
  return { ...baseOptions, ...rest };
}

if (watch) {
  for (const b of builds) {
    const ctx = await context(toEsbuildOptions(b));
    await ctx.watch();
  }
  console.log('[pixel] watching for changes...');
  process.on('SIGINT', () => process.exit(0));
} else {
  for (const b of builds) {
    await build(toEsbuildOptions(b));
  }
  writeManifest();
  console.log('[pixel] build complete');
}
