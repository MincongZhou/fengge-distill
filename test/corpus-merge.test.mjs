// 多源语料合并的测试。
//
// 钉住的是 v1.6.1 修的那个"文档说三期、尺子量两期"的落差：统计基准必须看到
// 主流行 + 增量语料，而这两份文件的**字段名和日期格式都不一样**。
// 三条都踩过真实坑，每条都配了反例：
//   ① 增量用 is_long/is_retweet，主流用 isLong/retweeted —— 不归一化会把长文/转发算成原创短帖
//   ② 增量 created_at 是 `Wed Jun 10 16:00:02 +0800 2026`，切片比字符串会让整个三期落空（且不报错）
//   ③ 两份在 6–8 月重叠 461 条 —— 不去重就重复计数
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeIso, normalizePost, mergePosts, loadWeiboAll, sourcesLine } from '../skills/fengge-wangming-tianya/scripts/corpus-path.mjs'

async function withTmp(build) {
  const root = await mkdtemp(join(tmpdir(), 'fengge-merge-test-'))
  try { return await build(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('normalizeIso：Date.toString 风格 → ISO（这条不对，三期会整体落空）', () => {
  const iso = normalizeIso('Wed Jun 10 16:00:02 +0800 2026')
  assert.match(iso, /^2026-06-10T/, `应转成 ISO，实际 ${iso}`)
  assert.equal(iso.slice(0, 10), '2026-06-10')
})

test('normalizeIso：已是 ISO 的原样保留，数字时间戳按毫秒/秒都吃得下', () => {
  assert.equal(normalizeIso('2026-08-30T05:38:00.000Z'), '2026-08-30T05:38:00.000Z')
  assert.equal(normalizeIso(1756179480000).slice(0, 4), '2025')
  assert.equal(normalizeIso(1756179480).slice(0, 4), '2025')
  assert.equal(normalizeIso(''), '')
  assert.equal(normalizeIso(null), '')
})

test('normalizeIso：真解析不了的原样返回，不猜成 1970', () => {
  assert.equal(normalizeIso('不是一个日期'), '不是一个日期')
})

test('normalizePost：增量字段名归一化到主流那套（反例：不归一化会把长文/转发当原创）', () => {
  const inc = { id: '1', text: '一段话', is_long: true, is_retweet: true, created_at: 'Wed Jun 10 16:00:02 +0800 2026' }
  const p = normalizePost(inc)
  assert.equal(p.isLong, true)
  assert.equal(p.retweeted, true)
  assert.equal(p.text_raw, '一段话')
  assert.equal(p.iso.slice(0, 10), '2026-06-10')
  // 原始字段仍在（不丢信息）
  assert.equal(p.is_long, true)
  assert.equal(p.text, '一段话')
})

test('normalizePost：主流字段名不被改写', () => {
  const p = normalizePost({ id: '2', text: 'x', isLong: false, retweeted: false, iso: '2026-01-01T00:00:00Z' })
  assert.equal(p.isLong, false)
  assert.equal(p.retweeted, false)
  assert.equal(p.iso, '2026-01-01T00:00:00Z')
})

test('mergePosts：按 id 去重，主流行优先，并如实计数', () => {
  const main = [{ id: 'a', text: '一' }, { id: 'b', text: '二' }]
  const inc = [{ id: 'b', text: '二（增量里的同一贴）' }, { id: 'c', text: '三' }]
  const r = mergePosts(main, inc)
  assert.equal(r.posts.length, 3)
  assert.equal(r.added, 1)
  assert.equal(r.duplicates, 1)
  assert.equal(r.main, 2)
  assert.equal(r.increment, 2)
  // 主流行优先：id=b 保留的是主流行那条正文
  assert.equal(r.posts.find((p) => p.id === 'b').text_raw, '二')
})

test('mergePosts：没有 id 时按正文去重（否则重复帖会被算两遍）', () => {
  const r = mergePosts([{ text: '同一句话' }], [{ text: '同一句话' }, { text: '另一句' }])
  assert.equal(r.posts.length, 2)
  assert.equal(r.duplicates, 1)
})

test('loadWeiboAll：主流行 + 增量合并；--no-increment 只读主流', async () => {
  await withTmp(async (dir) => {
    const main = join(dir, 'main.json')
    const inc = join(dir, 'inc.json')
    await writeFile(main, JSON.stringify([{ id: 'a', text: '主1', iso: '2026-01-01T00:00:00Z' }, { id: 'b', text: '主2', iso: '2026-01-02T00:00:00Z' }]), 'utf8')
    await writeFile(inc, JSON.stringify([
      { id: 'b', text: '重叠', created_at: 'Fri Jan 02 00:00:00 +0800 2026' },
      { id: 'c', text: '三期', is_long: false, created_at: 'Wed Sep 30 10:00:00 +0800 2026' },
    ]), 'utf8')

    const argv = ['--fb', main, '--corpus-increment', inc]
    const all = loadWeiboAll({ argv })
    assert.equal(all.stats.total, 3)
    assert.equal(all.stats.added, 1)
    assert.equal(all.stats.duplicates, 1)
    assert.equal(all.sources.length, 2)
    assert.match(sourcesLine(all), /主流 2 \+ 增量新增 1/)

    const noInc = loadWeiboAll({ argv: [...argv, '--no-increment'] })
    assert.equal(noInc.stats.total, 2)
    assert.equal(noInc.increment, null)
    assert.equal(noInc.sources.length, 1)
  })
})

test('loadWeiboAll：显式指定的增量语料不存在时必须报错，不许悄悄回退到仓库默认那份', async () => {
  await withTmp(async (dir) => {
    const main = join(dir, 'main.json')
    await writeFile(main, JSON.stringify([{ id: 'a', text: '主1' }]), 'utf8')
    // 实测踩过：回退到仓库内 data/posts.json（633 条）后，断言 1 条拿到的是 634 条
    assert.throws(
      () => loadWeiboAll({ argv: ['--fb', main, '--corpus-increment', join(dir, '不存在.json')], includeIncrement: true }),
      /显式指定的增量语料不存在/
    )
  })
})

test('loadWeiboAll：增量走 --no-increment 时完全不解析它（只跑主流行是合法用法）', async () => {
  await withTmp(async (dir) => {
    const main = join(dir, 'main.json')
    await writeFile(main, JSON.stringify([{ id: 'a', text: '主1' }]), 'utf8')
    const corpus = loadWeiboAll({ argv: ['--fb', main, '--no-increment'] })
    assert.equal(corpus.stats.total, 1)
    assert.equal(corpus.increment, null)
  })
})

test('loadWeiboAll：增量文件顶层不是数组时应报错，而不是静默当成空', async () => {
  await withTmp(async (dir) => {
    const main = join(dir, 'main.json')
    const inc = join(dir, 'bad.json')
    await writeFile(main, JSON.stringify([{ id: 'a', text: '主1' }]), 'utf8')
    await writeFile(inc, JSON.stringify({ oops: true }), 'utf8')
    assert.throws(() => loadWeiboAll({ argv: ['--fb', main, '--corpus-increment', inc] }), /顶层应为数组/)
  })
})
