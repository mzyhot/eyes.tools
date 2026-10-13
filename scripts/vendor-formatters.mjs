/* 𓁹𓁹: the formatters clean code loads, vendored into `fmt/`.
 *
 * The site has no build step, so each formatter ships as a file a page loads
 * with a plain <script>, and a WebAssembly one with its `.wasm` beside it. This
 * makes them all from the pinned npm packages below:
 *
 *   node scripts/vendor-formatters.mjs
 *
 * It installs the packages into a temporary folder, writes `fmt/`, and prints
 * what it wrote. Nothing it installs reaches the repository but `fmt/`. After
 * changing a version, run `npm run check`, `npm test` and the browser suite,
 * and try a few languages on the page.
 *
 * What each file defines when it has run:
 *   prettier.js            `prettier`, Prettier's standalone build
 *   prettier-<name>.js     `prettierPlugins.<name>`, a Prettier plugin
 *   sql-formatter.js       `sqlFormatter`
 *   <name>.js + .wasm      `wasmFmt.<name>`: `init(bytes)` once, then `format()`
 *   NOTICES.txt            what every other file contains, and the license
 *                          texts: each npm package in it, each project a
 *                          WebAssembly build compiles (fetched from GitHub),
 *                          and each Rust crate the build names (from crates.io)
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fmt');

const VERSIONS = {
  'prettier': '3.9.10',
  '@prettier/plugin-php': '0.25.0',
  '@prettier/plugin-xml': '3.4.2',
  'prettier-plugin-svelte': '4.1.1',
  'svelte': '5.57.2',
  'prettier-plugin-nginx': '2.0.0',
  'prettier-plugin-ini': '1.3.0',
  'prettier-plugin-properties': '0.3.1',
  'prettier-plugin-rust': '0.1.9',
  'prettier-plugin-latex': '2.0.1',
  'sql-formatter': '15.9.0',
  '@wasm-fmt/clang-format': '23.1.1',
  '@wasm-fmt/ruff_fmt': '0.15.20',
  '@wasm-fmt/gofmt': '0.7.3',
  '@wasm-fmt/lua_fmt': '0.3.3',
  '@wasm-fmt/zig_fmt': '0.16.0',
  '@wasm-fmt/shfmt': '0.2.7',
  '@wasm-fmt/taplo_fmt': '0.2.5',
  '@wasm-fmt/markup_fmt': '0.2.9',
  'esbuild': '0.28.2'
};

/* Prettier's own builds already define their globals. */
const PRETTIER_UMD = ['babel', 'estree', 'typescript', 'postcss', 'html', 'angular', 'glimmer', 'markdown', 'yaml', 'graphql'];

/* Plugins published as modules: bundled, with their imports of Prettier
   pointed at the `prettier` global the page has already loaded. */
const PRETTIER_BUNDLED = {
  xml: '@prettier/plugin-xml',
  svelte: 'prettier-plugin-svelte/browser',
  nginx: 'prettier-plugin-nginx',
  ini: 'prettier-plugin-ini',
  properties: 'prettier-plugin-properties',
  rust: 'prettier-plugin-rust',
  latex: 'prettier-plugin-latex'
};

/* WebAssembly formatters: the package's browser entry, and its .wasm. */
const WASM = {
  'clang-format': ['@wasm-fmt/clang-format/clang-format-web.js', '@wasm-fmt/clang-format/clang-format.wasm'],
  ruff: ['@wasm-fmt/ruff_fmt/ruff_fmt_web.js', '@wasm-fmt/ruff_fmt/ruff_fmt_bg.wasm'],
  gofmt: ['@wasm-fmt/gofmt/gofmt_web.js', '@wasm-fmt/gofmt/gofmt.wasm'],
  lua: ['@wasm-fmt/lua_fmt/lua_fmt_web.js', '@wasm-fmt/lua_fmt/lua_fmt_bg.wasm'],
  zig: ['@wasm-fmt/zig_fmt/zig_fmt_web.js', '@wasm-fmt/zig_fmt/zig_fmt.wasm'],
  shfmt: ['@wasm-fmt/shfmt/shfmt_web.js', '@wasm-fmt/shfmt/shfmt.wasm'],
  taplo: ['@wasm-fmt/taplo_fmt/taplo_fmt_web.js', '@wasm-fmt/taplo_fmt/taplo_fmt_bg.wasm'],
  markup: ['@wasm-fmt/markup_fmt/markup_fmt_web.js', '@wasm-fmt/markup_fmt/markup_fmt_bg.wasm']
};

/* What each WebAssembly build compiles besides its npm wrapper: the project,
   and the toolchain whose runtime it carries, with each one's license file. */
const LLVM = ['LLVM', 'Apache-2.0 WITH LLVM-exception', 'https://github.com/llvm/llvm-project', 'llvm/llvm-project/main/clang/LICENSE.TXT'];
const EMSCRIPTEN = ['Emscripten', 'MIT OR NCSA', 'https://github.com/emscripten-core/emscripten', 'emscripten-core/emscripten/main/LICENSE'];
const GO = ['Go', 'BSD-3-Clause', 'https://github.com/golang/go', 'golang/go/master/LICENSE'];
const TINYGO = ['TinyGo', 'BSD-3-Clause', 'https://github.com/tinygo-org/tinygo', 'tinygo-org/tinygo/release/LICENSE'];
const UPSTREAM = {
  'clang-format': [LLVM, EMSCRIPTEN],
  ruff: [['Ruff', 'MIT', 'https://github.com/astral-sh/ruff', 'astral-sh/ruff/main/LICENSE']],
  gofmt: [GO, TINYGO],
  lua: [['StyLua', 'MPL-2.0', 'https://github.com/JohnnyMorganz/StyLua', 'JohnnyMorganz/StyLua/main/LICENSE.md']],
  zig: [['Zig', 'MIT', 'https://github.com/ziglang/zig', 'ziglang/zig/master/LICENSE']],
  shfmt: [['sh', 'BSD-3-Clause', 'https://github.com/mvdan/sh', 'mvdan/sh/master/LICENSE'], GO, TINYGO],
  taplo: [['Taplo', 'MIT', 'https://github.com/tamasfe/taplo', 'tamasfe/taplo/master/LICENSE']],
  markup: [['markup_fmt', 'MIT', 'https://github.com/g-plane/markup_fmt', 'g-plane/markup_fmt/main/LICENSE']]
};

/* Packages that ship a prebuilt bundle with no source map to say what it
   holds: their notices cover everything they depend on instead. */
const UNMAPPED = ['@prettier/plugin-php', 'prettier-plugin-latex'];

const LICENSE_FILE = /^(licen[cs]e|copying|notice|third-party-notices)/i;
const curl = (url, file) => execFileSync('curl', ['-fsSL', '--retry', '3', url, ...(file ? ['-o', file] : [])],
  { encoding: file ? undefined : 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });

const work = mkdtempSync(join(tmpdir(), 'eyes-fmt-'));
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, dependencies: VERSIONS }, null, 2));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: work, stdio: 'inherit' });
  const modules = join(work, 'node_modules');
  const require = createRequire(join(work, 'package.json'));
  const esbuild = require('esbuild');
  const manifest = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const header = pkg => {
    const { version, license } = manifest(join(modules, pkg));
    return `/*! ${pkg} ${version} (${license}), vendored by scripts/vendor-formatters.mjs. Notices: fmt/NOTICES.txt. */\n`;
  };

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);

  /* Everything a file in fmt/ contains, for NOTICES.txt: each component once,
     with its license and where its source is, and which files hold it. */
  const components = new Map();
  const contents = [];
  /* A package's license files; one that ships none, its repository's. */
  const repositories = new Map();
  const licenseTexts = (dir, repository) => {
    const texts = readdirSync(dir).filter(f => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()
      .map(f => [f, readFileSync(join(dir, f), 'utf8')]);
    const github = /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?(?:[/#]|$)/.exec(repository || '');
    if (texts.length || !github) return texts;
    if (!repositories.has(github[1])) repositories.set(github[1], ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-APACHE'].flatMap(f => {
      try { return [[`${f} in ${github[1]}`, curl(`https://raw.githubusercontent.com/${github[1]}/HEAD/${f}`)]]; } catch { return []; }
    }));
    return repositories.get(github[1]);
  };
  const npmPackage = dir => {
    const { name, version, license, repository } = manifest(dir);
    const key = `npm:${name}@${version}`;
    if (!components.has(key)) components.set(key, {
      name: `${name} ${version}`, license: typeof license === 'string' ? license : license && license.type,
      source: `https://www.npmjs.com/package/${name}/v/${version}`,
      texts: licenseTexts(dir, typeof repository === 'string' ? repository : repository && repository.url)
    });
    return key;
  };
  const crate = (name, ver) => {
    const key = `crate:${name}@${ver}`;
    if (!components.has(key)) {
      const dir = join(work, 'crates');
      const file = join(dir, `${name}-${ver}.crate`);
      mkdirSync(dir, { recursive: true });
      curl(`https://static.crates.io/crates/${name}/${name}-${ver}.crate`, file);
      execFileSync('tar', ['-xzf', file, '-C', dir]);
      const src = join(dir, `${name}-${ver}`);
      const cargo = readFileSync(join(src, 'Cargo.toml'), 'utf8');
      const field = entry => (new RegExp(`^${entry}\\s*=\\s*"([^"]*)"`, 'm').exec(cargo) || [])[1];
      components.set(key, {
        name: `${name} ${ver} (Rust crate)`, license: field('license'),
        source: `https://crates.io/crates/${name}/${ver}`, texts: licenseTexts(src, field('repository'))
      });
    }
    return key;
  };
  const upstream = ([name, license, repo, file]) => {
    const key = 'upstream:' + name;
    if (!components.has(key)) components.set(key, { name, license, source: repo, texts: [[file.split('/').pop(), curl('https://raw.githubusercontent.com/' + file)]] });
    return key;
  };
  const record = (files, keys) => contents.push([files.map(f => 'fmt/' + f), [...new Set(keys)]]);
  const packageDir = file => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)[1];
  const installed = (owner, name) => {
    const dir = [join(owner, 'node_modules', name), join(modules, name)].find(dir => existsSync(join(dir, 'package.json')));
    if (!dir) throw new Error(`${name}, which ${owner} bundles, is not installed`);
    return dir;
  };
  const dependencies = (dir, found = new Map()) => {
    for (const name of Object.keys(manifest(dir).dependencies || {})) {
      if (name === 'prettier' || found.has(name)) continue;
      found.set(name, installed(dir, name));
      dependencies(found.get(name), found);
    }
    return found;
  };
  /* A package that ships a prebuilt bundle names what it bundled in the
     bundle's source map; one in UNMAPPED, by what it depends on. Each is read
     where npm installed it. */
  const bundledIn = file => {
    const owner = packageDir(file);
    if (UNMAPPED.includes(manifest(owner).name)) return [...dependencies(owner).values()].map(npmPackage);
    const map = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(readFileSync(file, 'utf8'));
    if (!map || map[1].startsWith('data:') || !existsSync(join(dirname(file), map[1]))) return [];
    const names = JSON.parse(readFileSync(join(dirname(file), map[1]), 'utf8')).sources
      .map(source => /^.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source)).filter(Boolean).map(match => match[1]);
    return [...new Set(names)].map(name => npmPackage(installed(owner, name)));
  };

  /* Imports of Prettier inside a bundled plugin, answered by the globals. */
  const prettierGlobals = {
    name: 'prettier-globals',
    setup(build) {
      build.onResolve({ filter: /^prettier(\/.*)?$/ }, args => ({ path: args.path, namespace: 'prettier-global' }));
      build.onLoad({ filter: /.*/, namespace: 'prettier-global' }, args => {
        const target = args.path.startsWith('prettier/plugins/') ? `globalThis.prettierPlugins.${args.path.slice(17).replace(/\.js$/, '')}`
          : /^prettier\/doc(\.js)?$/.test(args.path) ? 'globalThis.prettier.doc' : 'globalThis.prettier';
        return { contents: `module.exports = ${target};`, loader: 'js' };
      });
    }
  };
  /* The bundle, and the npm packages esbuild read to make it. */
  const bundle = async (source, plugins = []) => {
    const result = await esbuild.build({
      stdin: { contents: source, resolveDir: work, loader: 'js' }, absWorkingDir: work, metafile: true,
      bundle: true, format: 'iife', minify: true, write: false, legalComments: 'none',
      target: 'es2020', platform: 'browser', plugins, logLevel: 'error',
      /* Every formatter is handed its bytes, so the URL a module would find
         its own .wasm by is never used. */
      define: { 'import.meta.url': '""' }
    });
    const inputs = Object.keys(result.metafile.inputs).map(input => join(work, input)).filter(file => file.includes('/node_modules/'));
    return { code: result.outputFiles[0].text, packages: inputs.flatMap(file => [npmPackage(packageDir(file)), ...bundledIn(file)]) };
  };
  /* A prebuilt file, copied: what it holds is its package and what it bundled. */
  const copy = (file, from) => {
    const path = join(modules, from);
    writeFileSync(join(out, file), header(manifest(packageDir(path)).name) + readFileSync(path, 'utf8'));
    return [npmPackage(packageDir(path)), ...bundledIn(path)];
  };

  record(['prettier.js', ...PRETTIER_UMD.map(name => `prettier-${name}.js`)], [copy('prettier.js', 'prettier/standalone.js'),
    ...PRETTIER_UMD.map(name => copy(`prettier-${name}.js`, `prettier/plugins/${name}.js`))].flat());
  record(['prettier-php.js'], copy('prettier-php.js', '@prettier/plugin-php/standalone.js'));
  for (const [name, entry] of Object.entries(PRETTIER_BUNDLED)) {
    const pkg = entry.startsWith('@') ? entry.split('/').slice(0, 2).join('/') : entry.split('/')[0];
    const { code, packages } = await bundle(`import * as plugin from ${JSON.stringify(entry)};
      const found = plugin.default && plugin.default.parsers ? plugin.default : plugin;
      globalThis.prettierPlugins = globalThis.prettierPlugins || {};
      globalThis.prettierPlugins[${JSON.stringify(name)}] = found;`, [prettierGlobals]);
    writeFileSync(join(out, `prettier-${name}.js`), header(pkg) + code);
    record([`prettier-${name}.js`], packages);
  }
  record(['sql-formatter.js'], copy('sql-formatter.js', 'sql-formatter/dist/sql-formatter.min.js'));
  for (const [name, [entry, wasm]] of Object.entries(WASM)) {
    const pkg = entry.split('/').slice(0, 2).join('/');
    const { code, packages } = await bundle(`import init, * as formatter from ${JSON.stringify(entry)};
      globalThis.wasmFmt = globalThis.wasmFmt || {};
      globalThis.wasmFmt[${JSON.stringify(name)}] = { init: init, format: formatter.format };`);
    writeFileSync(join(out, `${name}.js`), header(pkg) + code);
    copyFileSync(join(modules, wasm), join(out, `${name}.wasm`));
    /* A Rust build names the crates it compiled in the paths its panics
       print; the projects it builds come from UPSTREAM. */
    const binary = readFileSync(join(modules, wasm)).toString('latin1');
    const crates = [...binary.matchAll(/registry\/src\/[^/]+\/([A-Za-z0-9_-]+?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?)\//g)]
      .map(([, crateName, crateVersion]) => crateName + '@' + crateVersion);
    record([`${name}.js`, `${name}.wasm`], [...packages, ...UPSTREAM[name].map(upstream),
      ...[...new Set(crates)].sort().map(id => crate(...id.split('@')))]);
  }

  /* NOTICES.txt: what each file holds, then each license text once, headed by
     everything that ships it. */
  const lines = [
    'Notices for the formatters in fmt/',
    '==================================',
    '',
    'clean code loads these files the first time a language needs one.',
    'scripts/vendor-formatters.mjs makes them from the npm packages named',
    'below; a WebAssembly build also compiles the projects and Rust crates named',
    'with it. Each keeps its own license. The license texts follow the list,',
    'each once, headed by everything that ships it, and each component\'s source',
    'is at the address given with it.',
    '',
    '',
    'What each file contains',
    '-----------------------'
  ];
  for (const [files, keys] of contents) {
    lines.push('', files.join(', '));
    for (const key of keys) {
      const { name, license, source } = components.get(key);
      lines.push(`  ${name}, ${license || 'license in its files'}: ${source}`);
    }
  }
  const texts = new Map();
  const bare = [];
  for (const { name, license, texts: files } of components.values()) {
    if (!files.length) bare.push(`${name} (${license})`);
    for (const [file, text] of files) {
      const body = text.replace(/\r\n?/g, '\n').trim();
      if (!texts.has(body)) texts.set(body, []);
      texts.get(body).push(`${name}, ${file}`);
    }
  }
  lines.push('', '', 'License texts', '-------------');
  if (bare.length) lines.push('', 'These ship no license file of their own, only the license their package', 'names: ' + bare.join(', ') + '.');
  for (const [body, owners] of texts) lines.push('', '', '== ' + owners.join('; ') + ' ==', '', body);
  writeFileSync(join(out, 'NOTICES.txt'), lines.join('\n') + '\n');

  const files = readdirSync(out).sort();
  for (const file of files) console.log(`${String(statSync(join(out, file)).size).padStart(9)}  fmt/${file}`);
  console.log(`wrote ${files.length} files to fmt/, with notices for ${components.size} components`);
  if (bare.length) console.log('no license file of their own: ' + bare.join(', '));
} finally {
  rmSync(work, { recursive: true, force: true });
}
