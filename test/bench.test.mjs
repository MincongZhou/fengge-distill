// 度量工具的测试。
//
// 为什么这些也要测：这一层是"尺子"。BLEU、ROUGE-L、JSD、κ、照抄检测里任何一个算错，
// 下游整张消融表的结论就都是错的，而且**错得很像对的**——数值照常输出、趋势照样好看。
// 所以每个指标都要有一个手算得出的正例和一个反例。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { charBleu, rougeL, jsd, longestCommonSubstring, verbatimCheck, charNgrams, distinctN, featureVector } from '../bench/metrics.mjs'
import { wilson, cohenKappa } from '../bench/labels.mjs'
import { makeSampler, sampleIndices, biliFragments } from '../bench/items.mjs'
import { trainablePosts, timeSplit } from '../bench/lora.mjs'
import { isPeak, costOfCall, costOfRun, loadPricing } from '../bench/pricing.mjs'
import { delta } from '../bench/ablation.mjs'

test('charNgrams：边界与计数', () => {
  assert.deepEqual([...charNgrams('ab', 2).entries()], [['ab', 1]])
  assert.equal(charNgrams('aaa', 2).get('aa'), 2)
  assert.equal(charNgrams('ab', 3).size, 0)          // 比文本还长的 n-gram 不该凭空造出来
})

test('charBleu：完全一致 → 高；毫不重合 → 0', () => {
  const ref = ['今天收工吃碗面，三十二，跟家人们报备一下']
  const same = charBleu(ref[0], ref)
  assert.ok(same.bleu > 0.9, `自比应接近 1，实际 ${same.bleu}`)
  const none = charBleu('Quantum chromodynamics', ref)
  assert.equal(none.bleu, 0)
})

test('charBleu：任一阶精度为 0 时整分为 0（标准 corpus BLEU 行为，不做平滑）', () => {
  // 逐字相同但顺序打乱 → 1-gram 有重合、2-gram 大概率全不中
  const cand = '一二三四五六七八九十'
  const ref = ['十九八七六五四三二一']
  const r = charBleu(cand, ref)
  assert.ok(r.precisions[0] > 0, '1-gram 应有重合')
  assert.equal(r.bleu, 0, '高阶精度为 0 时必须归零，而不是被平滑救回来')
})

test('charBleu：多参考取每 n-gram 的最大计数（参考多不该反被罚）', () => {
  const a = charBleu('我是一个打工人', ['我是一个打工人', '完全不同的一句话'])
  assert.ok(a.bleu > 0.9)
})

test('rougeL：相同 → 1；无公共字符 → 0', () => {
  assert.equal(rougeL('今天吃面', '今天吃面').f, 1)
  assert.equal(rougeL('abc', 'xyz').f, 0)
})

test('rougeL：LCS 而非最长公共子串（可跳字符）', () => {
  // LCS("abcde","ace") = "ace"，长 3 → p=3/5=0.6, r=1
  const r = rougeL('abcde', 'ace')
  assert.equal(r.lcs, 3)
  assert.equal(r.r, 1)
})

test('jsd：同一分布 → 0；正交分布 → 1 bit', () => {
  assert.equal(jsd([1, 2, 3], [1, 2, 3]), 0)
  assert.equal(jsd([1, 0], [0, 1]), 1)
  assert.ok(jsd([1, 1], [1, 0]) > 0 && jsd([1, 1], [1, 0]) < 1)
})

test('longestCommonSubstring：取出的是连续片段', () => {
  const m = longestCommonSubstring('今天收工吃碗面', '收工吃碗')
  assert.equal(m.len, 4)
  assert.equal(m.text, '收工吃碗')
  assert.equal(longestCommonSubstring('abc', 'xyz').len, 0)
})

test('verbatimCheck：跳过"与自己相同"的那条（否则 real 对照恒等于全长）', () => {
  const corpus = ['今天收工吃碗面，跟家人们报备一下', '沪指失守3900，我满仓没动']
  const self = verbatimCheck([corpus[0]], corpus)
  assert.ok(self.maxLen < [...corpus[0]].length, `跳过自身后不应等于整条长度，实际 ${self.maxLen}`)
  const copied = verbatimCheck(['我今天就抽一部iPhone 17，5499元这个，转发关注'], ['日子不过了，现在就开始抽，抽一部iPhone 17，5499元这个。转发+关注'])
  assert.ok(copied.maxLen >= 10, `整句照抄应被识别，实际 ${copied.maxLen}`)
  assert.equal(copied.over10, 1)
})

test('distinctN：重复句会把 distinct-3 拉低', () => {
  const same = distinctN(['今天收工吃碗面', '今天收工吃碗面', '今天收工吃碗面'], 3)
  const diff = distinctN(['今天收工吃碗面', '沪指失守三千九', '公司发了五仁月饼'], 3)
  assert.ok(same.d3 < diff.d3, `重复批的 distinct-3 应更低：${same.d3} vs ${diff.d3}`)
})

test('featureVector：长度与特征表一致，且取值在 [0,1]', () => {
  const v = featureVector(['今天收工吃碗面，跟家人们报备', '沪指失守3900'])
  assert.equal(v.length, 40)
  assert.ok(v.every((x) => x >= 0 && x <= 1))
})

test('wilson：手算锚点与性质', () => {
  const [lo, hi] = wilson(5, 10)
  assert.ok(lo > 0.18 && lo < 0.24, `lo 应约 0.20，实际 ${lo}`)
  assert.ok(hi > 0.76 && hi < 0.82, `hi 应约 0.79，实际 ${hi}`)
  assert.deepEqual(wilson(0, 0), [0, 0])
  const [a, b] = wilson(0, 10)
  assert.equal(a, 0)
  assert.ok(b > 0, '0/10 的上界不该是 0（这是 Wilson 相对正态近似的意义）')
})

test('cohenKappa：完全一致 → 1；完全随机 → 接近 0；已知 2×2 手算', () => {
  assert.equal(cohenKappa([[1, 1], [0, 0], [1, 1]]).kappa, 1)
  // 手算：n=10，混淆 [[5,0],[5,0]] → po=0.5, a1=5,b1=5 → pe=0.5 → κ=0
  assert.equal(cohenKappa([...Array(5)].map(() => [1, 1]).concat([...Array(5)].map(() => [0, 1]))).kappa, 0)
  assert.equal(cohenKappa([]).n, 0)
})

test('抽样：取高位后不退化，且抽不满会抛错而不是静默少给', () => {
  const rand = makeSampler(20261012)
  const seen = new Set()
  for (let i = 0; i < 2000; i++) seen.add(rand(30))
  assert.equal(seen.size, 30, `x % n 的低位退化会让覆盖率不足，实际覆盖 ${seen.size}/30`)

  const idx = sampleIndices(100, 20, makeSampler(7))
  assert.equal(idx.length, 20)
  assert.equal(new Set(idx).size, 20, '不能有重复索引')

  // 退化随机源：永远返回同一个值 → 必须抛错，不能返回 1 条糊弄过去
  assert.throws(() => sampleIndices(100, 5, () => 0), /抽样退化/)
})

test('抽样：同种子两次结果完全一致（可复现）', () => {
  const a = sampleIndices(500, 30, makeSampler(42))
  const b = sampleIndices(500, 30, makeSampler(42))
  assert.deepEqual(a, b)
})

test('trainablePosts：过滤转发/长文/过短，并按文本去重', () => {
  const arr = [
    { text: '今天收工吃碗面，跟家人们报备一下', iso: '2026-01-02' },
    { text: '今天收工吃碗面，跟家人们报备一下', iso: '2026-01-03' },  // 重复
    { text: '短', iso: '2026-01-01' },                                  // 过短
    { text: '转发的东西', retweeted: true },
    { text: '很长的长文', isLong: true },
  ]
  const posts = trainablePosts(arr)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].text, '今天收工吃碗面，跟家人们报备一下')
})

test('timeSplit：时间切分而非随机切分（train 全早于 dev）', () => {
  const posts = Array.from({ length: 10 }, (_, i) => ({ text: `t${i}`, iso: `2026-01-0${i + 1}` }))
  const { train, dev } = timeSplit(posts, 0.2)
  assert.equal(train.length, 8)
  assert.equal(dev.length, 2)
  assert.ok(train[train.length - 1].iso < dev[0].iso, 'train 的最大时间必须早于 dev 的最小时间')
})

test('biliFragments：句切分 + 长度区间 + 去重（同一份字幕资产会被复用）', () => {
  const bl = {
    BV1: { sub: ['今天我们来聊聊这个股票的事情，对吧。这个票我拿了很多年了，一直没有动过。'] },
    BV2: { sub: ['这个票我拿了很多年了，一直没有动过。'] },   // 与上一条重复
  }
  const frags = biliFragments(bl, { minLen: 8, maxLen: 30 })
  const texts = frags.map((f) => f.text)
  assert.ok(texts.every((t) => [...t].length >= 8 && [...t].length <= 30))
  assert.equal(new Set(texts).size, texts.length, '必须去重')
})

test('价格：peak/off-peak 判定按 UTC 星期与小时', () => {
  const p = loadPricing()
  // 2026-10-12 是周一：05:25 UTC 在 [01,04) 与 [06,10) 之外 → off-peak
  assert.equal(isPeak(new Date('2026-10-12T05:25:00Z'), p), false)
  assert.equal(isPeak(new Date('2026-10-12T02:00:00Z'), p), true)
  assert.equal(isPeak(new Date('2026-10-12T07:30:00Z'), p), true)
  // 周六 02:00 UTC → 全周都不是 peak
  assert.equal(isPeak(new Date('2026-10-10T02:00:00Z'), p), false)
})

test('成本：缓存命中价是未命中的 1/50，且输出按 completion_tokens 计（含 reasoning）', () => {
  const p = loadPricing()
  const at = new Date('2026-10-12T05:25:00Z')   // off-peak
  const miss = costOfCall({ prompt_tokens: 1e6, prompt_cache_hit_tokens: 0, completion_tokens: 0 }, at, { pricing: p })
  const hit = costOfCall({ prompt_tokens: 1e6, prompt_cache_hit_tokens: 1e6, completion_tokens: 0 }, at, { pricing: p })
  assert.equal(miss.usd, 0.15)
  assert.equal(hit.usd, 0.003)
  const out = costOfCall({ prompt_tokens: 0, prompt_cache_hit_tokens: 0, completion_tokens: 1e6 }, at, { pricing: p })
  assert.equal(out.usd, 0.6)
  assert.equal(out.tier, 'off-peak')
  // 缓存命中 token 不该被当成未命中重复计费
  const mixed = costOfCall({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 0 }, at, { pricing: p })
  assert.equal(mixed.missTok, 100)
  assert.equal(mixed.cacheTok, 900)
})

test('成本汇总：cacheHitRate 与调用数', () => {
  const at = new Date('2026-10-12T05:25:00Z')
  const r = costOfRun([
    { at, usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 0, completion_tokens: 100 } },
    { at, usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 1000, completion_tokens: 100 } },
  ])
  assert.equal(r.calls, 2)
  assert.equal(r.cacheHitRate, 0.5)
  assert.equal(r.tiers['off-peak'], 2)
})

test('delta：越低越好的指标，改善时符号为正', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`)   // 浮点：(0.3-0.2)/0.2 = 0.4999999999999999
  near(delta(0.2, 0.1, true), 0.5)     // 失败率减半 → +50% 改善
  near(delta(0.2, 0.3, true), -0.5)
  near(delta(0.4, 0.6, false), 0.5)    // 带内率 40%→60%
  assert.equal(delta(0, 1, true), null)        // 基数为 0 时不给百分比（避免除零编出一个数）
  assert.equal(delta(null, 1, true), null)
})
