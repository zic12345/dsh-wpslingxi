import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDirectory, '../..');
const outputPath = resolve(packageRoot, 'lib/client/panel.js');
// ⚠ loaderId 必须与 package.json 的包名一致（dsh-client-modules 按它去重/物化）。
const loaderId = 'dsh-wpslingxi';

const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  // 与母插件同口径：保留中文原文（加载器按 utf8 解码 bundle）。
  charset: 'utf8',
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  // 经典转换（React.createElement）：宿主 module loader 只保证提供 react，
  // 母插件 bundle 也只 require("react")，故不依赖 react/jsx-runtime 子路径。
  jsx: 'transform',
  external: ['react', 'react-dom'],
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
});
const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('esbuild did not produce a client bundle');

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, wrapped, 'utf8');
console.log(`Wrote ${outputPath}`);
