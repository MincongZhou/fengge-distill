#!/usr/bin/env node
/**
 * style-features — 峰哥体特征定义（单一来源）。
 *
 * 为什么要有它：**同一个特征，fengge-ratio 和 fengge-align 各抄了一份正则**。
 * ratio 定义 40 条、align 只判其中 28 条，两边各写各的 pattern——
 * 改一处忘了改另一处，就会出现"基准说 A、对齐判 B"的静默错位。
 * 这类"多个工具读同一份数据却各用各的规则"的不确定性，比数值错更难查。
 * 所以特征表在这里定义一次，ratio / align / bench 全部从这里取。
 *
 * 加特征或改正则的规矩：
 *   ① 只在这里改；
 *   ② 每条都要能指到语料实测（references/style-profile.md 或 style-ratios.md）；
 *   ③ 改完跑 `npm run accept` —— 黄金批次的带内比例会立刻告诉你有没有把尺子改歪。
 *
 * 只读、零依赖、不联网：ratio / align / lint 与包外的评测脚本都 import 它。
 */

/** 全部 40 条特征，顺序即 style-ratios.json 的输出顺序 */
export const FEATURES = [
  ['含「我」', /我/], ['含「你」', /你/], ['含「你们」', /你们/], ['含「大家」', /大家/], ['含「家人们」', /家人们/],
  ['含问号', /？/], ['含数字', /\d/], ['含话题标签', /#[^#\n]{2,}#/],
  ['免责句', /个人观点|不构成[^。！？]{0,8}建议|个人看法|个人判断|个人猜测/],
  ['你们…我…对仗', /你们[^。！？\n]{0,30}我/],
  ['假口头禅', /我算了|算了算|算下来|这账|算账|换算成|建议大家|建议你们|够我买|白赚|茶叶蛋|性价比|本质上/],
  ['顿号/分号', /[、；]/], ['换行', /\n/], ['方括号表情', /\[[^\]\s]{1,6}\]/], ['图形 emoji', /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u],
  ['结尾不加标点', /[^。！？]$/], ['句号收尾', /。$/], ['感叹号收尾', /！$/], ['问号收尾', /？$/],
  ['以「我」开头', /^我/], ['以「峰哥」开头', /^峰哥/], ['以话题标签开头', /^#/],
  ['含「为什么」', /为什么/], ['含「其实」', /其实/], ['含「啥」', /啥/], ['含「赚」', /赚/], ['含「亏」', /亏/], ['含「回本」', /回本/],
  ['含「割肉」', /割肉/], ['含「满仓」', /满仓/], ['含「抽奖」', /抽奖/], ['含「红包」', /红包/], ['含「流量」', /流量/],
  ['含「太吓人了」', /太吓人了/], ['含「报备」', /报备/], ['含「牛」', /牛/],
  ['极短帖(≤14字)', (t) => [...t].length <= 14], ['短帖(15-50)', (t) => [...t].length >= 15 && [...t].length <= 50],
  ['中帖(51-103)', (t) => [...t].length >= 51 && [...t].length <= 103], ['长帖(>103)', (t) => [...t].length > 103],
];

/**
 * fengge-align 参与判定与打分的子集（其余 12 条只进基准表供人读）。
 * 顺序即 align 报告的行序——改动它会改报告，属有意为之，别顺手重排。
 */
export const ALIGN_FEATURES = [
  '含「我」', '含「你」', '含「你们」', '含问号', '含数字', '含话题标签', '免责句', '你们…我…对仗', '假口头禅',
  '顿号/分号', '换行', '方括号表情', '结尾不加标点', '句号收尾', '感叹号收尾', '问号收尾',
  '以「我」开头', '以「峰哥」开头', '含「为什么」', '含「太吓人了」', '含「家人们」', '含「满仓」', '含「割肉」', '含「抽奖」',
  '极短帖(≤14字)', '短帖(15-50)', '中帖(51-103)', '长帖(>103)',
];

const BY_NAME = new Map(FEATURES);

/** 取某个特征的判定器（regex 或 fn）。名字写错必须炸，不许静默返回 undefined。 */
export function matcherFor(name) {
  const m = BY_NAME.get(name);
  if (!m) throw new Error(`未知特征「${name}」——特征表只有：${[...BY_NAME.keys()].join(' / ')}`);
  return m;
}

/** 单条文本命中某特征？ */
export function hits(text, name) {
  const m = matcherFor(name);
  return typeof m === 'function' ? m(text) : m.test(text);
}

/**
 * 一批文本在各特征上的命中数/比例。
 * @returns {{n:number, rows: Array<{name,hits,p}>}}
 */
export function proportions(texts, names = FEATURES.map((f) => f[0])) {
  const n = texts.length;
  return {
    n,
    rows: names.map((name) => {
      const k = texts.filter((t) => hits(t, name)).length;
      return { name, hits: k, p: n ? k / n : 0 };
    }),
  };
}

/** 自检：特征表本身没有重复名、每条都能判定、ALIGN 子集都存在于全表 */
export function selfcheck() {
  const problems = [];
  if (new Set(FEATURES.map((f) => f[0])).size !== FEATURES.length) problems.push('FEATURES 里有重名');
  for (const [name, m] of FEATURES) {
    try {
      if (typeof m === 'function') m('测试文本'); else m.test('测试文本');
    } catch (e) { problems.push(`特征「${name}」判定时抛错：${e.message}`); }
  }
  for (const name of ALIGN_FEATURES) if (!BY_NAME.has(name)) problems.push(`ALIGN_FEATURES 里的「${name}」不在全表中`);
  return { ok: problems.length === 0, problems, total: FEATURES.length, align: ALIGN_FEATURES.length };
}
