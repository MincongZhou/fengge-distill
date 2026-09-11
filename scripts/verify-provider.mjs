#!/usr/bin/env node
// fengge-distill 打包契约自检。
//
// 只读检查，不联网、不起子进程、不写任何文件。它验证 DSH STORE 固定 Commit
// 门禁关心的那些项，以及本包 provider 在宿主里能否真的列出并加载技能：
//   1. package.json 的清单字段（name/version/license/repository/main/dsh.bundle.patch）
//   2. 兼容性矩阵 dsh.compatibility.dshReleases 的取值合法性
//   3. Bundle Patch 的存在性、entry id 唯一性、以及「只新增」边界
//   4. 无安装期生命周期脚本（preinstall/install/postinstall/prepare）
//   5. 包内无符号链接（会触发扫描面不完整）
//   6. lib/index.js 以编程方式加载后，provider 的 list()/get() 能返回技能正文
//   7. dsh.plugin.json 的 id/version/contributes.skills 与包内技能一致
//
// 用法：node scripts/verify-provider.mjs
import { readFile, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

const COMPATIBILITY_VALUES = new Set(['compatible', 'incompatible', 'unknown'])
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

function check(label, condition, detail) {
  if (condition) {
    notes.push(`  ok   ${label}`)
    return true
  }
  failures.push(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  return false
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** 递归收集目录下的相对路径，同时记录符号链接。 */
async function walk(root, prefix = '') {
  const files = []
  const symlinks = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      symlinks.push(rel)
      continue
    }
    if (entry.isDirectory()) {
      const nested = await walk(root, rel)
      files.push(...nested.files)
      symlinks.push(...nested.symlinks)
      continue
    }
    if (entry.isFile()) files.push(rel)
  }
  return { files, symlinks }
}

const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const plugin = JSON.parse(await readFile(join(packageRoot, 'dsh.plugin.json'), 'utf8'))

// 1. 清单字段
const repositoryUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
check('package name is a legal, non-official npm name',
  typeof pkg.name === 'string' && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg.name)
  && !pkg.name.startsWith('@deepseek-ai/'), pkg.name)
check('package version is SemVer', /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ''), pkg.version)
check('version matches dsh.plugin.json', pkg.version === plugin.version, { pkg: pkg.version, plugin: plugin.version })
check('license is declared as a string', typeof pkg.license === 'string', pkg.license)
check('repository is a public GitHub url',
  typeof repositoryUrl === 'string' && repositoryUrl.includes('github.com'), repositoryUrl)
check('runtime entry is declared', typeof pkg.main === 'string' && await pathExists(join(packageRoot, pkg.main)), pkg.main)
check('files[] whitelist is declared', Array.isArray(pkg.files) && pkg.files.length > 0, pkg.files)
check('dsh.bundle.patch is declared', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh?.bundle?.patch)

// 2. 兼容性矩阵
const releases = pkg.dsh?.compatibility?.dshReleases
if (check('dsh.compatibility.dshReleases is an object with entries',
  releases !== null && typeof releases === 'object' && !Array.isArray(releases) && Object.keys(releases).length > 0)) {
  const invalid = Object.entries(releases)
    .filter(([, value]) => !COMPATIBILITY_VALUES.has(value))
    .map(([version, value]) => ({ version, value }))
  check('every dshReleases value is compatible/incompatible/unknown', invalid.length === 0, invalid)
  const flagged = Object.entries(releases).filter(([, value]) => value === 'compatible').map(([version]) => version)
  check('at least one release is declared exactly compatible', flagged.length > 0, flagged)
  notes.push(`       declared compatible: ${flagged.join(', ')}`)
}

// 3. Bundle Patch
const patchRel = pkg.dsh?.bundle?.patch
const patchPath = patchRel ? join(packageRoot, patchRel.replace(/^\.\//, '')) : null
const patchExists = patchPath ? await pathExists(patchPath) : false
if (check('bundle patch file exists inside the package', patchExists, patchRel)) {
  const patchText = await readFile(patchPath, 'utf8')
  const entryIds = [...patchText.matchAll(/^\s*-\s*id:\s*['"]?([^'"\s#]+)['"]?/gm)].map(match => match[1])
  check('bundle patch inserts at least one entry id', entryIds.length > 0, entryIds)
  check('bundle entry ids are unique', entryIds.length === new Set(entryIds).size, entryIds)
  check('bundle patch is additive only (no remove/disable/patch keys)',
    !/^\s*(remove|disable|patch):/im.test(patchText))
  check('bundle patch does not touch official entry ids or packages',
    !/(remove|disable|patch):[\s\S]{0,240}(@deepseek-ai\/|dsh-base|dsh-web-app|dsh-headless)/i.test(patchText))
  check('entry id matches the package name',
    entryIds.includes(pkg.name), { entryIds, packageName: pkg.name })
  check('entry id is prefixed with dsh- and is plugin-owned (not official)',
    entryIds.every(id => id.startsWith('dsh-') && !id.startsWith('@deepseek-ai')), entryIds)
  check('dsh.plugin.json contributes.skills is declared as an id list',
    Array.isArray(plugin.contributes?.skills))
}

// 4. 生命周期脚本
const lifecycle = Object.keys(pkg.scripts ?? {}).filter(script => LIFECYCLE_SCRIPTS.includes(script))
check('no preinstall/install/postinstall/prepare scripts', lifecycle.length === 0, lifecycle)
check('no runtime dependencies are declared',
  Object.keys(pkg.dependencies ?? {}).length === 0, pkg.dependencies)

// 5. 符号链接
const { files, symlinks } = await walk(packageRoot)
const scanned = files.filter(file => !file.startsWith('node_modules/') && !file.startsWith('.git/'))
check('package contains no symbolic links', symlinks.length === 0, symlinks)

// 6. provider 行为
const moduleUrl = pathToFileURL(join(packageRoot, pkg.main ?? 'lib/index.js')).href
const module = await import(moduleUrl)
check('module exports apply/name/inject',
  typeof module.apply === 'function' && typeof module.name === 'string' && Array.isArray(module.inject),
  { name: module.name, inject: module.inject })
check('module injects the skills service', module.inject.includes('skills'), module.inject)

let provider = null
const fakeCtx = { skills: { registerProvider: factory => { provider = factory({}) } } }
module.apply(fakeCtx)
if (check('apply() registers exactly one skill provider', provider !== null && provider.name === module.name, provider?.name)) {
  const candidates = await provider.list({})
  check('provider.list() discovers at least one skill', candidates.length > 0, candidates.length)
  const names = candidates.map(candidate => candidate.name)
  notes.push(`       discovered skills: ${names.join(', ')}`)
  check('every candidate declares name and description',
    candidates.every(candidate => candidate.name.length > 0 && candidate.description.length > 0))
  check('provider.get() returns content plus a directory resource base',
    await (async () => {
      for (const candidate of candidates) {
        const skill = await provider.get(candidate, {})
        if (!skill || skill.content.length === 0) return false
        if (skill.resourceBase?.kind !== 'directory') return false
        if (!await pathExists(join(skill.resourceBase.path, 'SKILL.md'))) return false
      }
      return true
    })())
  check('dsh.plugin.json contributes.skills matches discovered skill names',
    (plugin.contributes?.skills ?? []).every(skill => names.includes(skill))
    && (plugin.contributes?.skills ?? []).length === names.length,
    { declared: plugin.contributes?.skills, discovered: names })
}

// 7. 只读报告
const relativeFiles = scanned.length
notes.push(`       scanned ${relativeFiles} package files, ${relative(packageRoot, patchPath ?? packageRoot) || '.'} included`)

process.stdout.write(`fengge-distill package contract\n${notes.join('\n')}\n`)
if (failures.length > 0) {
  process.stdout.write(`${failures.join('\n')}\nPROVIDER_VERIFY_FAILED ${failures.length}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('PROVIDER_VERIFY_OK\n')
}
