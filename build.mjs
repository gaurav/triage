// Builds the CLI (one file, Node) and every view under ui/<name>/ (browser bundles).
// `node build.mjs --watch` rebuilds on change for `npm run dev`.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const define = { __CHAFF_VERSION__: JSON.stringify(pkg.version) };
const views = readdirSync('ui').filter((d) => d !== 'shared' && statSync(join('ui', d)).isDirectory());

// The browser build must never pull in Node code: `core/` is shared with the UI, and the plan
// says a `node:` import there should break the build, so resolve it to nothing and fail.
const noNodeBuiltins = {
  name: 'no-node-builtins',
  setup(b) {
    b.onResolve({ filter: /^node:|^(fs|path|http|os|child_process|crypto|url|util|stream)$/ }, (args) => ({
      errors: [{ text: `Node built-in "${args.path}" imported from ${args.importer}; ui/ and src/core/ must stay browser-safe` }],
    }));
  },
};

const cli = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
  define,
  sourcemap: 'inline',
  logLevel: 'info',
};

const uiBuilds = views.map((name) => ({
  entryPoints: [`ui/${name}/main.tsx`],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outdir: `dist/ui/${name}`,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define,
  // A map is handy while developing; the package does not need 466 KB of it.
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  plugins: [noNodeBuiltins],
  logLevel: 'info',
}));

function copyStatic() {
  for (const name of views) {
    mkdirSync(`dist/ui/${name}`, { recursive: true });
    for (const f of readdirSync(`ui/${name}`)) {
      if (/\.(html|css|svg|png|ico)$/.test(f)) cpSync(`ui/${name}/${f}`, `dist/ui/${name}/${f}`);
    }
  }
}

rmSync('dist', { recursive: true, force: true });
copyStatic();
if (watch) {
  const ctxs = await Promise.all([cli, ...uiBuilds].map((o) => context(o)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log(`watching ${views.length} view(s) + cli`);
} else {
  await Promise.all([cli, ...uiBuilds].map((o) => build(o)));
  // esbuild writes the shebang but not the mode bit.
  const { chmodSync } = await import('node:fs');
  chmodSync('dist/cli.js', 0o755);
}
