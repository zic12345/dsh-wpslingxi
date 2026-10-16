// 把宿主侧需要的静态资源复制到 lib/。
//
// `tsc` 只编译 .ts，不会搬运 boot.cjs（Windows 侧引导脚本）。
// 而 package.json 的 files 只发布 `lib`，因此该资源必须落到 lib/ 才能随插件分发。
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

/** 源 → 目标（相对 packageRoot）。 */
const ASSETS = [
  ['src/lingxi-assets/boot.cjs', 'lib/lingxi-assets/boot.cjs'],
]

for (const [from, to] of ASSETS) {
  const source = resolve(packageRoot, from)
  if (!existsSync(source)) {
    throw new Error(`缺少构建资源 ${from}`)
  }
  const target = resolve(packageRoot, to)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  console.log(`Wrote ${target}`)
}
