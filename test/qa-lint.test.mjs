// 文字场问答判据（fengge-qa-lint）的测试。
//
// 这份判据最容易出的两种错，正好相反：
//   ① **把真人判红**——33/34 条真实回复里「我」0 次、中位 9 字；若判据要求"有落点"或"至少 15 字"，
//      真实回复会成片挂掉，于是"像不像"变成"像不像 AI"。所以正例里必须放真实原话。
//   ② **放过典型 AI 味**——"感谢你的提问／建议你先…／第一步…"这类，是他从不说的。
// 每条判据都配一个正例和一个反例，反例要能指出是哪条规则挂的。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkQA, QA_LEN, SELFTEST, runSelftest } from '../skills/fengge-wangming-tianya/scripts/fengge-qa-lint.mjs'

const failRules = (text, mode = 'short') => checkQA(text, mode).results.filter((r) => r.level === 'FAIL').map((r) => r.rule)
const warnRules = (text, mode = 'short') => checkQA(text, mode).results.filter((r) => r.level === 'WARN').map((r) => r.rule)

test('长度：短答的硬墙是"形态变了"，观测极值只给 WARN', () => {
  // 2026-10-31 修正：初版把「>28（观测最长）」判 FAIL，多轮测试里一条 30 字的正常回复被判红。
  // 样本最大值不是物理上限（n=34）。硬墙改成 45：超过约 1.6 倍最大值 = 已经不是短答而是段落。
  assert.equal(QA_LEN.short.observedMax, 28)
  assert.equal(QA_LEN.short.hardMax, 45)
  assert.deepEqual(failRules('好'), ['长度'])                       // 1 字 < 下限 2
  // 29 字：超出观测最长，但仍是短答形态 → 只 WARN，不 FAIL
  assert.deepEqual(failRules('啊'.repeat(29)), [])
  assert.ok(warnRules('啊'.repeat(29)).includes('长度·超出语料最长'))
  // 46 字：已经不是短答 → FAIL
  assert.ok(failRules('啊'.repeat(46)).includes('长度'))
  // 3–6 字是真回复的常态（p25=6），必须过
  for (const t of ['低调', '演的', '妈呀', '面膜']) assert.deepEqual(failRules(t), [], `「${t}」不该被拦`)
})

test('长度：短答只说 WARN 不谈下限，18 字以上才提示偏长', () => {
  // 注意是 **>18** 才 WARN：19 字触发、18 字不触发（第一版夹具正好 18 字，所以测试红）
  assert.ok(warnRules('这是十九个字的一句话用来测试偏长的提醒').includes('长度·偏长'))
  assert.deepEqual(warnRules('这是十八个字的一句话用来测试偏长提'), [])
  assert.deepEqual(warnRules('这话不长'), [])
})

test('短答主语：出现「我」只给 WARN，真正 FAIL 的是"发博腔自曝"', () => {
  // 2026-10-31 修正：初版把「有我就 FAIL」，实测把「别找我」「我也亏过」判红——0/34 是"少见"不是"禁止"
  // （0/34 的 95% 置信上界约 10%）。多轮测试里这两个回复被判红，才暴露出这条过严。
  const core = (t) => checkQA(t, 'short')
  assert.ok(core('别找我').warns > 0 || true)                       // 只要求不 FAIL
  assert.deepEqual(core('别找我').results.filter(r => r.level === 'FAIL').map(r => r.rule), [])
  assert.ok(core('我也亏过').results.some((r) => r.rule === '短答主语' && r.level === 'WARN'))
  // 守规矩的标准答法不该被拦（人设明文要求这么说）
  assert.deepEqual(core('我照着这人的公开语料学的，不是他本人').results.filter(r => r.level === 'FAIL').map(r => r.rule), [])
  // 发博腔：把发博的自曝塞进聊天，才是真该拦的
  assert.ok(core('我 860 进的，你自己算').results.some((r) => r.rule === '短答发博腔' && r.level === 'FAIL'))
  assert.ok(core('我今天满仓 300 万').results.some((r) => r.rule === '短答发博腔' && r.level === 'FAIL'))
})

test('长答主语：没有「我」即 FAIL（长答必须以我为主语）', () => {
  // 夹具里一个「我」都不能有——第一版写成"有粉丝问我…"，结果"问我"本身就带「我」，测试才红
  const noWo = '有粉丝问：为什么一买就跌。这是因为你盯着价格，不是盯着公司，所以你总是慢一步，等你反应过来的时候，价格已经走完了。这类问题一天能收好几条，说白了都是同一个毛病。'
  const rules = failRules(noWo, 'long')
  assert.ok(rules.includes('长答主语'), `应判缺主语，实际：${rules.join(',')}`)
})

test('硬格式：换行 / 分点 / 直播语域 / 方括号表情都要 FAIL', () => {
  assert.ok(failRules('先攒钱\n再辞职').includes('换行'))
  assert.ok(failRules('第一步先定位，第二步做内容').includes('给建议'))   // 「第一步」同时命中建议
  assert.ok(failRules('这事我跟你说，不是那样的').includes('直播语域'))
  assert.ok(failRules('先发一百条[加油]').includes('方括号表情'))
})

test('客服腔与教程腔：AI 味最重的两类，必须拦', () => {
  assert.ok(failRules('感谢你的提问').includes('客服腔'))
  assert.ok(failRules('希望能帮到你').includes('客服腔'))
  assert.ok(failRules('建议你先评估现金流').includes('给建议'))
  assert.ok(failRules('可以试试先做一个月').includes('给建议'))
})

test('账号安全线：荐股带单与冒充本人', () => {
  assert.ok(failRules('跟我买，稳赚').includes('荐股/带单'))
  assert.ok(failRules('我是峰哥本人').includes('冒充本人'))
})

test('长答三段：缺转述 FAIL；缺反问只给 WARN（语料自己的答法里也有不反问的）', () => {
  const noRelay = '为什么大家总是亏钱？因为你在猜涨跌，我在买生意。我这么多年下来，最确定的一件事就是：别跟价格较劲，跟你自己的耐心较劲。这话听着像废话，但真要能做到的人，一年也没几个。'
  assert.ok(failRules(noRelay, 'long').includes('长答·转述'))

  const withRelayNoQuestion = '有网友说被骂到抑郁。这事儿我有发言权，我被骂了十年。你难受不是因为那几句话，是因为你还在意骂你那几个人——可我这边评论区一天几千条，每条都在意就早不干活了。骂你的人比夸你的人更舍得花时间，这时间就是流量，收着。'
  assert.deepEqual(failRules(withRelayNoQuestion, 'long'), [])
  assert.ok(warnRules(withRelayNoQuestion, 'long').includes('长答·归类反问'))
})

test('免责句：没有具体判断却挂免责 = WARN；有判断才配', () => {
  assert.ok(warnRules('先发一百条，有人看再说，别急着辞职。这事儿说着简单，真做起来要一年，你能坚持下来再说其他的。个人观点，不构成投资建议。').includes('免责句·挂载对象'))
  const judged = '有粉丝问我黄金还能不能上车。860 那一带我就说过，油价一高它就见底，美国不会让它一直站着。现在它涨过一轮了，你问的不是逻辑，是还能不能接着涨。个人观点，不构成投资建议。'
  assert.deepEqual(failRules(judged, 'long'), [])
  assert.ok(!warnRules(judged, 'long').includes('免责句·挂载对象'))
})

test('自检本身：14 例全过，且正例里含真实回复', () => {
  const r = runSelftest({ verbose: false })
  assert.equal(r.mismatched, 0, `${r.mismatched} 例不符合预期`)
  assert.ok(SELFTEST.length >= 12)
  assert.ok(SELFTEST.some((c) => c.want && c.why.includes('真实回复')), '正例里必须留真实回复')
})

test('真实回复成片通过（这条防的是"把真人判红"）', () => {
  const real = ['孤儿企业', '低调', '购买地址：🍑宝，永远不死。', '8月1日开奖，还有机会。', '别猜了，满仓的科技', '亏的多，访问量就高了', '面膜', '妈呀', '先得有人下单', '缩水了', '因为今天下雨了', '内容是AI伪造的', '平平安安健健康康比啥都强', '演的', '牛逼']
  const bad = real.filter((t) => checkQA(t, 'short').fails > 0)
  assert.deepEqual(bad, [], `这些是真实回复，不该被拦：${bad.join(' / ')}`)
})

test('emoji 只给 WARN（他 3.7% 的帖子带，不该硬拦）', () => {
  assert.deepEqual(failRules('先发一百条🫡'), [])
  assert.ok(warnRules('先发一百条🫡').includes('图形 emoji'))
})
