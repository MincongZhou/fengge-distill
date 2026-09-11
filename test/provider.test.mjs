// fengge-distill 打包契约与 provider 边界测试。
//
// 只读 + 临时目录夹具：不写真实 DSH_HOME，不联网，不起子进程，不改任何用户状态。
// 失败即 fail closed —— 断言失败直接让 node --test 非零退出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { apply, name, inject, discoverCandidates, parseFrontmatter, parseSkillFile } from '../lib/index.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const plugin = JSON.parse(await readFile(join(packageRoot, 'dsh.plugin.json'), 'utf8'))

/** 在系统临时目录里建一个夹具目录，测试结束由调用方删除。 */
async function withFixture(build) {
  const root = await mkdtemp(join(tmpdir(), 'fengge-distill-test-'))
  try {
    await build(root)
    return root
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

test('bundle patch is additive, plugin-owned and uniquely identified', async () => {
  const patchRel = pkg.dsh?.bundle?.patch
  assert.equal(typeof patchRel, 'string', 'package.json must declare dsh.bundle.patch')
  const patchText = await readFile(join(packageRoot, patchRel.replace(/^\.\//, '')), 'utf8')
  const entryIds = [...patchText.matchAll(/^\s*-\s*id:\s*['"]?([^'"\s#]+)['"]?/gm)].map(match => match[1])
  assert.equal(entryIds.length, 1, 'the patch must insert exactly one entry')
  assert.equal(entryIds[0], pkg.name, 'the entry id must be plugin-owned and match the package name')
  assert.ok(!/^\s*(remove|disable|patch):/im.test(patchText), 'the patch must not remove/disable/patch anything')
  assert.ok(
    !/(remove|disable|patch):[\s\S]{0,240}(?:@deepseek-ai\/|dsh-base|dsh-web-app|dsh-headless)/i.test(patchText),
    'the patch must never touch official entries or @deepseek-ai packages'
  )
})

test('compatibility matrix only uses documented verdicts and keeps a compatible release', async () => {
  const releases = pkg.dsh?.compatibility?.dshReleases ?? {}
  const versions = Object.keys(releases)
  assert.ok(versions.length > 0, 'dshReleases must declare per-version verdicts')
  for (const [version, verdict] of Object.entries(releases)) {
    assert.ok(['compatible', 'incompatible', 'unknown'].includes(verdict), `${version} has an unsupported verdict`)
  }
  assert.ok(
    Object.values(releases).includes('compatible'),
    'at least one release must be declared exactly compatible'
  )
})

test('package declares no install-time lifecycle scripts and no runtime dependencies', () => {
  const lifecycle = Object.keys(pkg.scripts ?? {}).filter(script =>
    ['preinstall', 'install', 'postinstall', 'prepare'].includes(script))
  assert.deepEqual(lifecycle, [], 'lifecycle scripts would run third-party code at install time')
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'the plugin must not pull in its own dependencies')
})

test('provider registers under the skills service and the manifest agrees with discovery', async () => {
  let provider = null
  apply({ skills: { registerProvider: factory => { provider = factory({}) } } })
  assert.ok(provider !== null, 'apply() must register exactly one provider')
  assert.equal(provider.name, name)
  assert.deepEqual(inject, ['skills'])

  const candidates = await provider.list({})
  assert.equal(candidates.length, plugin.contributes.skills.length, 'discovery must match contributes.skills')
  for (const candidate of candidates) {
    assert.ok(plugin.contributes.skills.includes(candidate.name), `${candidate.name} is not declared in dsh.plugin.json`)
    const skill = await provider.get(candidate, {})
    assert.ok(skill, 'get() must return the skill for a discovered candidate')
    assert.equal(skill.resourceBase.kind, 'directory')
    assert.ok(skill.content.length > 0, 'the skill body must be loaded on demand, not at list() time')
    assert.equal(candidate.content, undefined, 'list() must stay metadata-only')
  }
})

test('provider fails closed on malformed or missing skills instead of throwing', async () => {
  const root = await withFixture(async fixture => {
    await mkdir(join(fixture, 'no-frontmatter'), { recursive: true })
    await writeFile(join(fixture, 'no-frontmatter', 'SKILL.md'), '# 没有 frontmatter 的技能\n', 'utf8')
    await mkdir(join(fixture, 'empty-dir'), { recursive: true })
  })
  try {
    assert.deepEqual(await discoverCandidates(root, undefined), [], 'a malformed fixture must be skipped, not thrown')
    assert.deepEqual(await discoverCandidates(join(root, 'does-not-exist'), undefined), [], 'a missing root must fail closed')
    assert.equal(await parseSkillFile(join(root, 'does-not-exist', 'SKILL.md'), undefined), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('frontmatter parsing handles the literal and folded scalars this skill uses', () => {
  assert.equal(parseFrontmatter('# 无 frontmatter\n'), null)
  const folded = parseFrontmatter(['---', 'name: demo', 'description: >', '  一行', '  两行', '---', 'body'].join('\n'))
  assert.deepEqual(folded.metadata, { name: 'demo', description: '一行 两行' })
  assert.equal(folded.body, 'body')
  const literal = parseFrontmatter('---\nname: demo\ndescription: 用"引号"包住的描述\n---\nbody\n')
  assert.equal(literal.metadata.description, '用"引号"包住的描述')
})
