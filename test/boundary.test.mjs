// 包内外边界测试。
//
// 这个仓库有两层东西，界线一旦糊掉，最先出事的是 DSH STORE 的门禁（fail-closed）：
//   · 包内：会发到 npm、要过商店安全扫描 —— 必须**零运行期依赖、不联网、不起子进程、无凭据**
//   · 包外：bench/ security/ service/ —— 联网、要 API key、起子进程，**不许进 files**
//
// 注意范围：`scripts/distill*.js` 那两条抓取脚本虽然也在包里，但它们是**离线蒸馏管道**（需登录态、
// 不在插件运行路径上），README 已声明。所以这里断言的是**插件运行路径**：
// lib/ 下的 provider 与 skills/**/scripts/ 下技能真正会调用的那些 .mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

async function walk(dir) {
  const out = []
  for (const name of await readdir(dir)) {
    const p = join(dir, name)
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

test('包外目录（bench / security / service / docs）不得出现在 npm files 白名单里', () => {
  const files = pkg.files || []
  const leaks = files.filter((f) => /^(bench|security|service|docs)(\/|$)/.test(String(f)))
  assert.deepEqual(leaks, [], `这些是包外目录，不能进 files：${leaks.join(', ')}`)
  // 反向确认：包内该有的还在
  for (const must of ['lib', 'skills', 'test', 'cordis.patch.yml', 'dsh.plugin.json']) {
    assert.ok(files.some((f) => f === must || f.startsWith(must + '/')), `files 里应包含 ${must}`)
  }
})

test('插件运行路径（lib/ 与 skills/**/scripts/）不联网、不起子进程、不读凭据', async () => {
  const targets = [
    ...(await walk(join(root, 'lib'))),
    ...(await walk(join(root, 'skills', 'fengge-wangming-tianya', 'scripts'))),
  ].filter((f) => /\.(mjs|js)$/.test(f))

  assert.ok(targets.length >= 6, `应当扫到 provider 与技能脚本，实际只有 ${targets.length} 个文件`)

  const offenders = []
  for (const f of targets) {
    const lines = (await readFile(f, 'utf8')).split('\n')
    for (const [i, line] of lines.entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      if (/\bchild_process\b|\bexecFileSync\b|\bspawnSync\b/.test(line)) offenders.push(`${relative(root, f)}:${i + 1} 子进程: ${line.trim()}`)
      if (/\bfetch\s*\(|https?\.request|require\(['"]https?['"]\)|import\(['"]https?/.test(line)) offenders.push(`${relative(root, f)}:${i + 1} 网络: ${line.trim()}`)
      if (/DEEPSEEK_API_KEY|process\.env\.[A-Z_]*KEY|credentials\.yaml/.test(line)) offenders.push(`${relative(root, f)}:${i + 1} 凭据: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `插件运行路径越界（这些能力只允许存在于包外的 bench/security/service）：\n${offenders.join('\n')}`)
})

test('package.json 无运行期依赖、无生命周期脚本（商店门禁的硬要求）', () => {
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'dependencies 必须为空')
  assert.ok(!pkg.optionalDependencies || Object.keys(pkg.optionalDependencies).length === 0)
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
    assert.equal(pkg.scripts?.[hook], undefined, `不许有生命周期脚本 ${hook}`)
  }
})

test('联网/要 key 的脚本都落在包外目录（反向确认它们确实存在，不是把能力删了了事）', async () => {
  const outside = [
    'bench/lib/deepseek.mjs',        // 模型客户端
    'bench/generate.mjs',            // 生成
    'bench/metrics.mjs',             // 指标（本地计算，但在包外跑）
    'security/run.mjs',              // 安全探针
  ]
  for (const f of outside) {
    await stat(join(root, f))   // 不存在就抛错
  }
  // bench/lib/deepseek.mjs 是唯一解析凭据的地方。
  // 断言的是"不许把 key 本体打进日志"——打印长度与 3 字前缀（sk-）是**正确**做法，不能一并禁掉，
  // 所以只检查插值形态：console.log 里出现 ${key} 时，后面必须紧跟 .length 或 .slice(。
  const ds = await readFile(join(root, 'bench/lib/deepseek.mjs'), 'utf8')
  assert.match(ds, /DEEPSEEK_API_KEY/, '包外的客户端负责凭据解析')

  const leaks = []
  for (const [i, line] of ds.split('\n').entries()) {
    if (!line.includes('console.')) continue
    for (const m of line.matchAll(/\$\{key\}/g)) {
      const after = line.slice(m.index + m[0].length)
      if (!/^\.(length|slice\()/.test(after)) leaks.push(`deepseek.mjs:${i + 1} 直接插值了 key：${line.trim()}`)
    }
  }
  assert.deepEqual(leaks, [], `不许把 key 本体打进日志：\n${leaks.join('\n')}`)
})
