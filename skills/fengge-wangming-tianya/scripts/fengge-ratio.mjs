#!/usr/bin/env node
/**
 * fengge-ratio — 从语料算出每个特征的"比例 + 95% 置信区间"，供 align 做统计校验。
 * 输出 references/style-ratios.md（人读）+ data/style-ratios.json（机器读）。
 *
 * 关键：比例类特征不能再用"每 10 条应出现 3–4 条"这种粗表——
 * 语料自身有抽样误差，候选批次也有；两者合成一个允许带，超出才算偏。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const CORPUS = 'C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_v2_raw.json';

const arr = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const posts = arr.filter(x => !x.retweeted && !x.rtText && !x.isLong).map(x => String(x.text_raw || x.text || '').trim()).filter(Boolean);
const n = posts.length;

const FEATS = [
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

// Wilson 95% 区间（比正态近似稳，小样本比例也适用）
function wilson(k, m, z = 1.96) {
  if (!m) return [0, 0];
  const p = k / m, d = 1 + z * z / m;
  const c = p + z * z / (2 * m), h = z * Math.sqrt(p * (1 - p) / m + z * z / (4 * m * m));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

const out = [];
for (const [name, re] of FEATS) {
  const hits = posts.filter(t => (typeof re === 'function' ? re(t) : re.test(t))).length;
  const p = hits / n;
  const [lo, hi] = wilson(hits, n);
  out.push({ name, hits, p: +p.toFixed(4), ci: [+lo.toFixed(4), +hi.toFixed(4)] });
}
const lens = posts.map(t => [...t].length).sort((a, b) => a - b);
const pct = (q) => lens[Math.floor(lens.length * q)];
const length = { n, p10: pct(.1), p25: pct(.25), p50: pct(.5), p75: pct(.75), p90: pct(.9), p95: pct(.95), max: lens[lens.length - 1] };

const payload = { generatedAt: new Date().toISOString(), corpus: CORPUS, n, length, features: out };
fs.mkdirSync(path.join(SKILL_DIR, 'data'), { recursive: true });
fs.writeFileSync(path.join(SKILL_DIR, 'data', 'style-ratios.json'), JSON.stringify(payload, null, 2));

const lines = ['# 峰哥体特征比例基准（含 95% Wilson 置信区间，自动生成）', '',
  `> 语料：原创非长文 **${n} 条** ｜ 生成于 ${payload.generatedAt}`, '',
  '比例类特征的判据不是"必须等于语料值"，而是**落在语料的抽样误差带里**。候选批次自身也有抽样误差，',
  '所以 `fengge-align.mjs --batch-check` 用的是**合成区间**：`sqrt(语料方差/n + 批次方差/m)`。', '',
  '| 特征 | 语料命中 | 语料比例 | 95% CI |', '|---|---:|---:|---|'];
for (const f of out) lines.push(`| ${f.name} | ${f.hits} | ${(f.p * 100).toFixed(1)}% | ${(f.ci[0] * 100).toFixed(1)}% – ${(f.ci[1] * 100).toFixed(1)}% |`);
lines.push('', '## 长度分位', '', `p10 ${length.p10} ｜ p25 ${length.p25} ｜ **p50 ${length.p50}** ｜ p75 ${length.p75} ｜ p90 ${length.p90} ｜ p95 ${length.p95} ｜ max ${length.max}`, '');
fs.writeFileSync(path.join(SKILL_DIR, 'references', 'style-ratios.md'), lines.join('\n'));

console.log(`已生成 references/style-ratios.md + data/style-ratios.json（语料 ${n} 条，${out.length} 个特征）`);
console.log('样例：' + out.slice(0, 6).map(f => `${f.name} ${(f.p * 100).toFixed(1)}% [${(f.ci[0] * 100).toFixed(1)}–${(f.ci[1] * 100).toFixed(1)}]`).join(' ｜ '));
