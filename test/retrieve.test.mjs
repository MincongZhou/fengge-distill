// 检索器回归测试。
//
// 钉住两件容易被"看起来能跑"掩盖的事：
//   ① 中文分词不能留单字（单字=停用词级噪声，会把泛词抬到前面）
//   ② 打分必须做文档长度归一化（余弦会被 3 字短帖劫持，BM25 不会）—— 这是换成 BM25 的直接原因
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tokenize, buildIndex, retrieve, indexFromCorpus, eligibleText, MIN_EXAMPLE_LEN } from '../skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs'

const DOCS = [
  '沪指失守3900，我994一克买的黄金反倒红了，这波我不慌，仓位拿一路',
  '今天收工吃碗面，32，没约女粉，跟家人们报备',
  '公司发的中秋福利是一句祝福，我算了算这句祝福值0块',
  '上班。',
  '我天天上班，公司还要求下班后微信待命，这不就是把人当牲口使唤吗',
]

test('分词：多字汉字段不产生单字 token', () => {
  const toks = tokenize('下班待命')
  assert.deepEqual(toks.sort(), ['下班', '下班待', '班待', '班待命', '待命'].sort())
  assert.ok(!toks.includes('下'), '不应出现单字 token')
})

test('分词：单字段保留（否则「上班。」这类帖子会变成零向量）', () => {
  assert.deepEqual(tokenize('上'), ['上'])
})

test('分词：拉丁串整体保留并小写', () => {
  assert.ok(tokenize('ETF和HBM').includes('etf'))
  assert.ok(tokenize('ETF和HBM').includes('hbm'))
})

test('打分：超短帖不得压过真正相关的长帖（换成 BM25 的直接原因）', () => {
  const idx = buildIndex(DOCS)
  const hits = retrieve(idx, '我天天上班，公司还要求下班后微信待命，这合理吗', 5)
  const long = hits.findIndex((h) => h.text.startsWith('我天天上班'))
  const short = hits.findIndex((h) => h.text === '上班。')
  assert.equal(long, 0, `相关长帖应排第一，实际第 ${long + 1} 名`)
  assert.ok(short === -1 || short > long, `3 字「上班。」不得排在相关长帖之前，实际第 ${short + 1} 名`)
})

test('打分：自反性 —— 用文档自身当查询，它必须排第一', () => {
  const idx = buildIndex(DOCS)
  const hits = retrieve(idx, DOCS[1], 1)
  assert.equal(hits[0].text, DOCS[1])
})

test('打分：无共享 n-gram 时返回空数组（不抛错、不编造）', () => {
  const idx = buildIndex(DOCS)
  assert.deepEqual(retrieve(idx, 'Quantum chromodynamics lattice gauge', 3), [])
})

test('打分：结果按分数降序且同分时按索引稳定排序（可复现）', () => {
  const idx = buildIndex(DOCS)
  const a = retrieve(idx, '下班 上班 待命 公司', 5)
  const b = retrieve(idx, '下班 上班 待命 公司', 5)
  assert.deepEqual(a, b)
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].score >= a[i].score)
})

test('语料过滤：转发 / 长文 / 过短帖都不进检索素材', () => {
  assert.equal(eligibleText({ text: 'x', retweeted: true }), null)
  assert.equal(eligibleText({ text: 'x', isLong: true }), null)
  assert.equal(eligibleText({ text: '上班。' }), null, `短于 ${MIN_EXAMPLE_LEN} 字应被丢掉`)
  assert.ok(eligibleText({ text: '今天收工吃碗面，32，没约女粉，跟家人们报备' }))
})

test('indexFromCorpus：skipped 数对得上（等于被过滤掉的条数）', () => {
  const arr = [
    { text: '今天收工吃碗面，32，没约女粉，跟家人们报备' },
    { text: '上班。' },
    { text: '转发内容', retweeted: true },
    { text: '长文内容很长', isLong: true },
  ]
  const idx = indexFromCorpus(arr)
  assert.equal(idx.n, 1)
  assert.equal(idx.skipped, 3)
})

test('语料过滤：minLen 可调（消融里要复现"不过滤短帖"这一档）', () => {
  const idx = indexFromCorpus([{ text: '上班。' }, { text: '太帅了' }], { minLen: 1 })
  assert.equal(idx.n, 2)
})
