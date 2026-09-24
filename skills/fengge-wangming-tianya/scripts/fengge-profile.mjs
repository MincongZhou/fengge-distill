#!/usr/bin/env node
/**
 * fengge-profile — 从语料抽「峰哥风格基准画像」，供改 skill 与验收时当尺子用。
 *
 * 语料（默认路径可被 --fb / --bl 覆盖）：
 *   --fb  微博全量 fg_fengge_v2_raw.json（1921 条，含封禁前/后）
 *   --bl  B站直播切片 fg_bili_corpus.json（BV 为键，sub 为字幕行数组）
 *
 * 产出：
 *   references/style-profile.md   人读的画像（所有改动都要能引用这里的数字）
 *   data/style-profile.json       机器读的画像（给 lint / 对齐脚本用）
 *
 * 用法：node scripts/fengge-profile.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const FB = arg('--fb', 'C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_v2_raw.json');
const BL = arg('--bl', 'C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_bili_corpus.json');

const PUNCT = ['。', '！', '？', '，', '、', '；', '：', '…', '—', '"', '"', '(', ')'];
const STOP = new Set('的 了 是 在 我 你 他 她 它 我们 你们 他们 这 那 有 和 与 就 都 也 还 而 但 被 把 给 让 对 从 到 为 之 其 以 于 上 下 里 个 之 说 会 要 能 很 太 就是 一个 什么 怎么 为什么 因为 所以 如果 没有 不是 这种 这样 那么 时候 自己 知道 觉得 现在 可以 应该 已经'.split(' '));
const FORMAL = /然而|因此|综上|总的来说|总而言之|值得注意的是|众所周知|不可否认|从某种程度上|首先[，,].{0,40}其次|赋能|抓手|生态位|闭环|进一步|由此可见|一方面.{0,20}另一方面/;
const LINKWORDS = ['但是', '但', '其实', '反正', '说到底', '说白了', '就是', '真的', '所以', '因为', '如果', '而且', '然后', '结果', '不然', '要不然', '咋', '啥', '呗', '嘛', '呢', '吧', '啊', '呀', '哈'];
const ADDRESS = ['家人们', '兄弟们', '朋友们', '网友们', '姐妹们', '老铁', '大家', '你们', '你', '我'];
const NUMRE = [
  ['数字+块', /\d+(?:\.\d+)?\s*块/g], ['数字+万', /\d+(?:\.\d+)?\s*万/g], ['数字+元', /\d+(?:\.\d+)?\s*元/g],
  ['数字+%', /\d+(?:\.\d+)?\s*%/g], ['数字+折', /\d+(?:\.\d+)?\s*折/g], ['数字+岁', /\d+\s*岁/g],
  ['数字+年', /\d+\s*年/g], ['数字+天', /\d+\s*天/g], ['数字+个', /\d+\s*个/g], ['数字+成', /\d+\s*成/g],
  ['A比B比分', /\d+\s*比\s*\d+/g], ['我算了', /我?算了[一下]*/g], ['够我', /够我[\u4e00-\u9fa5]{0,4}/g],
  ['相当于', /相当于/g], ['等于', /等于/g],
];

const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0; };
const rate = (n, d) => `${(n / d * 100).toFixed(1)}%`;
const topN = (map, n = 12) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);

function charBigrams(texts) {
  const m = {};
  for (const t of texts) for (const clause of t.split(/[。！？，、；：…—\s"'()（）]+/)) {
    const c = clause.replace(/[0-9a-zA-Z#@]/g, '');
    for (let i = 0; i + 1 < c.length; i++) {
      const g = c.slice(i, i + 2);
      if (STOP.has(g) || STOP.has(g[0]) || STOP.has(g[1])) continue;
      m[g] = (m[g] || 0) + 1;
    }
  }
  return m;
}

// ---------- 微博 ----------
const fbRaw = JSON.parse(fs.readFileSync(FB, 'utf8'));
const posts = fbRaw.map(x => String(x.text_raw || x.text || '').trim()).filter(Boolean);
const era = { pre: [], post: [] };
fbRaw.forEach(x => {
  const t = String(x.text_raw || x.text || '').trim(); if (!t) return;
  const iso = x.iso || x.created_at || '';
  (/2026-05-1[3-9]|2026-0[6-9]/.test(iso) ? era.post : era.pre).push(t);
});
const lens = posts.map(t => [...t].length);
const ctx = {
  n: posts.length,
  len: { p10: pct(lens, .1), p25: pct(lens, .25), p50: pct(lens, .5), p75: pct(lens, .75), p90: pct(lens, .9), p95: pct(lens, .95), max: Math.max(...lens), mean: +(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1) },
  lenBuckets: {},
  punctuation: {},
  punctPer100: {},
  sentences: { p50: pct(posts.map(t => t.split(/[。！？]/).filter(Boolean).length), .5), multi: rate(posts.filter(t => t.split(/[。！？]/).filter(Boolean).length >= 3).length, posts.length) },
  openings: {}, openings2: {},
  endings: {}, endingChars: {},
  address: {}, linkwords: {}, numbers: {}, formal: {},
  topBigrams: [],
};
for (const b of [[0, 14], [15, 30], [31, 50], [51, 80], [81, 120], [121, 999]]) {
  const k = `${b[0]}–${b[1] === 999 ? '∞' : b[1]}`;
  ctx.lenBuckets[k] = rate(lens.filter(l => l >= b[0] && l <= b[1]).length, posts.length);
}
for (const p of PUNCT) {
  const hit = posts.filter(t => t.includes(p)).length;
  ctx.punctuation[p] = rate(hit, posts.length);
  ctx.punctPer100[p] = +((posts.reduce((a, t) => a + t.split(p).length - 1, 0)) / posts.reduce((a, t) => a + [...t].length, 0) * 100).toFixed(2);
}
const o1 = {}, o2 = {}, e4 = {}, ec = {};
for (const t of posts) {
  o1[[...t][0]] = (o1[[...t][0]] || 0) + 1;
  o2[[...t].slice(0, 2).join('')] = (o2[[...t].slice(0, 2).join('')] || 0) + 1;
  const parts = t.split(/[。！？]/).filter(Boolean);
  const last = (parts[parts.length - 1] || '').trim();
  if (last.length >= 2) e4[last.slice(-4)] = (e4[last.slice(-4)] || 0) + 1;
  ec[[...t].slice(-1)[0]] = (ec[[...t].slice(-1)[0]] || 0) + 1;
}
ctx.openings = Object.fromEntries(topN(o1, 12).map(([k, v]) => [k, `${v} (${rate(v, posts.length)})`]));
ctx.openings2 = Object.fromEntries(topN(o2, 12).map(([k, v]) => [k, `${v} (${rate(v, posts.length)})`]));
ctx.endings = Object.fromEntries(topN(e4, 10).map(([k, v]) => [k, `${v} (${rate(v, posts.length)})`]));
ctx.endingChars = Object.fromEntries(topN(ec, 10).map(([k, v]) => [k, `${v} (${rate(v, posts.length)})`]));
for (const a of ADDRESS) ctx.address[a] = rate(posts.filter(t => t.includes(a)).length, posts.length);
for (const w of LINKWORDS) { const c = posts.filter(t => t.includes(w)).length; if (c / posts.length > 0.005) ctx.linkwords[w] = rate(c, posts.length); }
for (const [name, re] of NUMRE) {
  const hits = posts.reduce((a, t) => a + (t.match(re) || []).length, 0);
  if (hits) ctx.numbers[name] = { 总次数: hits, 含它的帖子占比: rate(posts.filter(t => re.test(t)).length, posts.length) };
}
ctx.formal = { 命中帖子占比: rate(posts.filter(t => FORMAL.test(t)).length, posts.length) };
ctx.topBigrams = topN(charBigrams(posts), 30).map(([k, v]) => `${k}(${v})`);
ctx.era = {
  封禁前: { n: era.pre.length, p50: pct(era.pre.map(t => [...t].length), .5), mean: +(era.pre.reduce((a, t) => a + [...t].length, 0) / era.pre.length).toFixed(1) },
  解封后: { n: era.post.length, p50: pct(era.post.map(t => [...t].length), .5), mean: +(era.post.reduce((a, t) => a + [...t].length, 0) / era.post.length).toFixed(1) },
};

// ---------- 直播 ----------
const blRaw = JSON.parse(fs.readFileSync(BL, 'utf8'));
const live = [];
for (const [, v] of Object.entries(blRaw)) {
  const t = typeof v.sub === 'string' ? v.sub : Array.isArray(v.sub) ? v.sub.map(x => (typeof x === 'string' ? x : x.text || x.content || '')).join('') : '';
  if (t) live.push(t);
}
const liveChars = live.reduce((a, t) => a + [...t].length, 0);
const per10k = (n) => +(n / liveChars * 10000).toFixed(1);
const liveProfile = {
  videos: live.length, chars: liveChars,
  wordsPer10k: {},
};
for (const w of ['对吧', '对不对', '我跟你说', '说白了', '家人们', '兄弟们', '为什么', '我跟你说', '个人观点', '不构成', '咱们', '哥们', '我告诉你', '这么着', '玩意', '事儿']) {
  liveProfile.wordsPer10k[w] = per10k([...live.join('')].length ? (live.join('').split(w).length - 1) : 0);
}
liveProfile.topBigrams = topN(charBigrams(live), 30).map(([k, v]) => `${k}(${v})`);

const profile = { generatedAt: new Date().toISOString(), sources: { weibo: FB, bilibili: BL }, weibo: ctx, live: liveProfile };
fs.mkdirSync(path.join(SKILL_DIR, 'data'), { recursive: true });
fs.writeFileSync(path.join(SKILL_DIR, 'data', 'style-profile.json'), JSON.stringify(profile, null, 2));

const lines = [];
lines.push('# 峰哥风格基准画像（自动生成，勿手改）', '');
lines.push(`> 生成时间 ${profile.generatedAt} ｜ 微博 ${ctx.n} 条 ｜ 直播 ${liveProfile.videos} 条 / ${liveChars} 字`, '');
lines.push('## 一、微博：长度与篇幅', '');
lines.push(`p10 ${ctx.len.p10} / p25 ${ctx.len.p25} / **p50 ${ctx.len.p50}** / p75 ${ctx.len.p75} / p90 ${ctx.len.p90} / p95 ${ctx.len.p95} / max ${ctx.len.max} ｜ 均值 ${ctx.len.mean}`, '');
lines.push('分桶：' + Object.entries(ctx.lenBuckets).map(([k, v]) => `${k} 字 ${v}`).join(' ｜ '), '');
lines.push(`两期：封禁前 n=${ctx.era.封禁前.n} p50=${ctx.era.封禁前.p50} 均值=${ctx.era.封禁前.mean} ｜ 解封后 n=${ctx.era.解封后.n} p50=${ctx.era.解封后.p50} 均值=${ctx.era.解封后.mean}`, '');
lines.push('## 二、微博：标点习惯（每百字出现次数 / 含它的帖子占比）', '');
lines.push(Object.keys(ctx.punctuation).map(p => `${p} ${ctx.punctPer100[p]}/百字 (${ctx.punctuation[p]})`).join(' ｜ '), '');
lines.push(`句数：中位 ${ctx.sentences.p50} 句；≥3 句的帖子 ${ctx.sentences.multi}`, '');
lines.push('## 三、微博：开头与结尾', '');
lines.push('开头首字：' + Object.entries(ctx.openings).map(([k, v]) => `${k} ${v}`).join(' ｜ '), '');
lines.push('开头二字：' + Object.entries(ctx.openings2).map(([k, v]) => `${k} ${v}`).join(' ｜ '), '');
lines.push('结尾四字：' + Object.entries(ctx.endings).map(([k, v]) => `${k} ${v}`).join(' ｜ '), '');
lines.push('末位字符：' + Object.entries(ctx.endingChars).map(([k, v]) => `${k} ${v}`).join(' ｜ '), '');
lines.push('## 四、微博：称呼与语助词', '');
lines.push('称呼：' + Object.entries(ctx.address).map(([k, v]) => `${k} ${v}`).join(' ｜ '), '');
lines.push('连接/语助：' + Object.entries(ctx.linkwords).map(([k, v]) => `${k} ${v}`).join(' ｜ '), '');
lines.push('## 五、微博：数字怎么用', '');
lines.push(Object.entries(ctx.numbers).map(([k, v]) => `${k}: ${v.总次数} 次 / 帖子占比 ${v.含它的帖子占比}`).join('\n'), '');
lines.push(`书面/AI 味词命中帖子占比：${ctx.formal.命中帖子占比}`, '');
lines.push('## 六、微博：高频二字组 top30', '');
lines.push(ctx.topBigrams.join(' ｜ '), '');
lines.push('## 七、直播（第二语域）：语域词密度（每万字）', '');
lines.push(Object.entries(liveProfile.wordsPer10k).map(([k, v]) => `${k} ${v}`).join(' ｜ '), '');
lines.push('## 八、直播：高频二字组 top30', '');
lines.push(liveProfile.topBigrams.join(' ｜ '), '');
lines.push('', '---', '', '**用法**：改 SKILL.md 的每一条规则，都要能在这里指到具体数字；`fengge-lint.mjs` 的阈值也应当来自本文件。');
fs.writeFileSync(path.join(SKILL_DIR, 'references', 'style-profile.md'), lines.join('\n'));

console.log('画像已生成：');
console.log('  微博', ctx.n, '条 | p50', ctx.len.p50, '| 均值', ctx.len.mean, '| 含换行', 0);
console.log('  直播', liveProfile.videos, '条 |', liveChars, '字');
console.log('  输出: references/style-profile.md + data/style-profile.json');
console.log('\n关键数字预览：');
console.log('  长度分桶', Object.entries(ctx.lenBuckets).map(([k, v]) => k + ':' + v).join(' '));
console.log('  标点', Object.entries(ctx.punctPer100).slice(0, 8).map(([k, v]) => k + v).join(' '));
console.log('  称呼', Object.entries(ctx.address).map(([k, v]) => k + v).join(' '));
console.log('  数字句式', Object.keys(ctx.numbers).join(' '));
console.log('  直播语域', Object.entries(liveProfile.wordsPer10k).slice(0, 6).map(([k, v]) => k + v).join(' '));
