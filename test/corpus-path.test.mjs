// 语料可移植性回归测试。
//
// 钉住的是一个真实缺陷：v1.3.2 之前 fengge-ratio / fengge-align / fengge-profile 的默认语料路径
// 写死成 `C:/Users/ASUS/.../fg_fengge_v2_raw.json`，导致 `npm run ratio|align|accept`
// 换台机器或 CI 直接崩 —— 这也是 align/accept 一直没进 CI 的真因。
//
// 这里断言两件事：
//   ① corpus-path 的解析优先级与失败行为（找不到必须抛错并列出试过的路径，不许静默降级）
//   ② 「align / accept 不依赖语料」这个不变量（静态 + 动态两条：源码里不许再出现写死路径；
//      alignTexts 在不知语料为何物的情况下必须照常出分）
//
// 只读 + 临时目录夹具：不联网、不起子进程、不碰真实语料。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { resolveCorpus, loadCorpus, provenance, provenanceLine, CorpusNotFound, REPO_ROOT, CORPORA } from '../skills/fengge-wangming-tianya/scripts/corpus-path.mjs'
import { alignTexts } from '../skills/fengge-wangming-tianya/scripts/fengge-align.mjs'

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'fengge-wangming-tianya')

async function withTmp(build) {
  const root = await mkdtemp(join(tmpdir(), 'fengge-corpus-test-'))
  try { return await build(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('语料解析：显式 --corpus 优先于环境变量与搜索目录', async () => {
  await withTmp(async (dir) => {
    const explicit = join(dir, 'explicit.json')
    const fromEnv = join(dir, 'env.json')
    await writeFile(explicit, '[]', 'utf8')
    await writeFile(fromEnv, '[1]', 'utf8')
    const got = resolveCorpus({ name: 'x.json', cli: explicit, envValue: fromEnv, searchDirs: [dir] })
    assert.equal(got.path, resolve(explicit))
    assert.equal(got.source, 'cli')
  })
})

test('语料解析：没有显式路径时按环境变量取值', async () => {
  await withTmp(async (dir) => {
    const fromEnv = join(dir, 'env.json')
    await writeFile(fromEnv, '[]', 'utf8')
    const got = resolveCorpus({ name: 'x.json', envValue: fromEnv })
    assert.equal(got.path, resolve(fromEnv))
    assert.equal(got.source, 'env')
  })
})

test('语料缺失：抛 CorpusNotFound 并列出试过的每一个路径（不静默降级）', () => {
  let err = null
  try {
    resolveCorpus({ name: 'definitely-missing-corpus.json', cwd: tmpdir() })
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof CorpusNotFound, '找不到语料必须抛 CorpusNotFound，而不是返回 null/空基准')
  assert.ok(err.tried.length >= 3, `tried 应列出全部候选，实际 ${err.tried.length} 条`)
  assert.match(err.message, /找不到语料/)
  assert.match(err.message, /修法/)          // 报错必须给出修法，而不是只喊失败
  assert.match(err.message, /--corpus/)      // 至少包含一条可执行路径
})

test('语料形状：按规格校验顶层 JSON（微博=数组 / B站=对象），拿错文件早报错', async () => {
  await withTmp(async (dir) => {
    const asArray = join(dir, 'a.json')
    const asObject = join(dir, 'o.json')
    await writeFile(asArray, '[{"text":"x"}]', 'utf8')
    await writeFile(asObject, '{"BV1":"y"}', 'utf8')
    assert.deepEqual((await loadCorpus({ name: 'a.json', cli: asArray, shape: 'array' })).data.length, 1)
    assert.throws(() => loadCorpus({ name: 'a.json', cli: asArray, shape: 'object' }), /顶层应为对象/)
    assert.throws(() => loadCorpus({ name: 'o.json', cli: asObject, shape: 'array' }), /顶层应为数组/)
  })
})

test('语料形状：B站语料规格确实是 object（否则 fengge-profile 会崩在 for...of）', () => {
  assert.equal(CORPORA.bilibili.shape, 'object')
  assert.equal(CORPORA.weibo.shape, 'array')
})

test('溯源不写绝对路径：只记 name/sha256/bytes', async () => {
  await withTmp(async (dir) => {
    const f = join(dir, 'c.json')
    await writeFile(f, '[1,2,3]', 'utf8')
    const info = resolveCorpus({ name: 'c.json', cli: f })
    const p = provenance(info)
    assert.deepEqual(Object.keys(p).sort(), ['bytes', 'name', 'sha256', 'source'])
    assert.equal(p.name, 'c.json')
    assert.equal(p.bytes, 7)
    assert.match(p.sha256, /^[0-9a-f]{64}$/)
    assert.doesNotMatch(provenanceLine(info), /[A-Za-z]:[\\/]/)   // 人读行里也不许出现盘符
  })
})

test('不变量：包内脚本的代码行里不再出现盘符绝对路径（注释里作为历史说明可以）', async () => {
  const files = await readdir(join(skillRoot, 'scripts'))
  const offenders = []
  for (const f of files.filter((f) => f.endsWith('.mjs'))) {
    const src = await readFile(join(skillRoot, 'scripts', f), 'utf8')
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue          // 注释：允许讲这段历史
      if (/[A-Za-z]:[\\/]/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `脚本代码里仍有盘符绝对路径：\n${offenders.join('\n')}`)
})

test('不变量：语料只按文件名声明，路径一律靠解析', () => {
  for (const [key, spec] of Object.entries(CORPORA)) {
    assert.doesNotMatch(spec.name, /[\\/]/, `${key}.name 必须是纯文件名，不能带路径`)
    assert.match(spec.env, /^FG_/, `${key}.env 应是 FG_ 前缀的环境变量`)
  }
})

test('不变量：align 只依赖仓库内文件 —— 语料缺失也能照常出分', async () => {
  const ratios = JSON.parse(await readFile(join(skillRoot, 'data', 'style-ratios.json'), 'utf8'))
  assert.ok(ratios.comma, 'style-ratios.json 必须含逗号分位（否则 align 会退回读语料）')
  assert.ok(ratios.provenance?.sha256, 'style-ratios.json 必须含便携溯源')
  assert.equal(ratios.provenance.sha256.length, 64)

  const golden = (await readFile(join(skillRoot, 'evals', 'samples', 'golden-batch.txt'), 'utf8'))
    .split('\n').map((s) => s.trim()).filter(Boolean)
  const rep = alignTexts(golden)
  assert.equal(rep.n, golden.length)
  assert.equal(rep.score, 1, `黄金批次带内比例应为 100%，实际 ${(rep.score * 100).toFixed(0)}%`)
})

test('REPO_ROOT 由 import.meta.url 推导（可移植），且指向本包', async () => {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-fengge-distill')
})
