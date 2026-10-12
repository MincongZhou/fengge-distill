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
import { loadCorpusFromArgv, provenance, provenanceLine } from './corpus-path.mjs';
import { FEATURES } from './style-features.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');

// 语料路径不再写死本机绝对路径：--fb / --corpus / FG_CORPUS / 仓库相邻目录 依次尝试。
// 找不到就报出「试过哪些路径 + 怎么修」，不静默降级成空基准。
const info = loadCorpusFromArgv('weibo');
const arr = info.data;
const posts = arr.filter(x => !x.retweeted && !x.rtText && !x.isLong).map(x => String(x.text_raw || x.text || '').trim()).filter(Boolean);
const n = posts.length;

// Wilson 95% 区间（比正态近似稳，小样本比例也适用）
function wilson(k, m, z = 1.96) {
  if (!m) return [0, 0];
  const p = k / m, d = 1 + z * z / m;
  const c = p + z * z / (2 * m), h = z * Math.sqrt(p * (1 - p) / m + z * z / (4 * m * m));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

const out = [];
for (const [name, re] of FEATURES) {
  const hits = posts.filter(t => (typeof re === 'function' ? re(t) : re.test(t))).length;
  const p = hits / n;
  const [lo, hi] = wilson(hits, n);
  out.push({ name, hits, p: +p.toFixed(4), ci: [+lo.toFixed(4), +hi.toFixed(4)] });
}
const lens = posts.map(t => [...t].length).sort((a, b) => a - b);
const pct = (q) => lens[Math.floor(lens.length * q)];
const length = { n, p10: pct(.1), p25: pct(.25), p50: pct(.5), p75: pct(.75), p90: pct(.9), p95: pct(.95), max: lens[lens.length - 1] };

// 逗号中位带也在这里算好并落盘：否则 fengge-align 每次都要回头读一遍语料，
// 那正是它以前离不开本机 fg_fengge_v2_raw.json、进不了 CI 的原因。
const commas = posts.map(t => (t.match(/，/g) || []).length).sort((a, b) => a - b);
const comma = { p25: commas[Math.floor(n * .25)], p50: commas[Math.floor(n * .5)], p75: commas[Math.floor(n * .75)] };

// 溯源不写绝对路径（旧版把作者本机路径写进随仓库分发的 data/*.json）。
const payload = { generatedAt: new Date().toISOString(), provenance: provenance(info), n, length, comma, features: out };
fs.mkdirSync(path.join(SKILL_DIR, 'data'), { recursive: true });
fs.writeFileSync(path.join(SKILL_DIR, 'data', 'style-ratios.json'), JSON.stringify(payload, null, 2));

const lines = ['# 峰哥体特征比例基准（含 95% Wilson 置信区间，自动生成）', '',
  `> 语料：原创非长文 **${n} 条** ｜ ${provenanceLine(info)} ｜ 生成于 ${payload.generatedAt}`, '',
  '比例类特征的判据不是"必须等于语料值"，而是**落在语料的抽样误差带里**。候选批次自身也有抽样误差，',
  '所以 `fengge-align.mjs` 用的是**合成区间**：`sqrt(语料方差/n + 批次方差/m)`。', '',
  '| 特征 | 语料命中 | 语料比例 | 95% CI |', '|---|---:|---:|---|'];
for (const f of out) lines.push(`| ${f.name} | ${f.hits} | ${(f.p * 100).toFixed(1)}% | ${(f.ci[0] * 100).toFixed(1)}% – ${(f.ci[1] * 100).toFixed(1)}% |`);
lines.push('', '## 长度分位', '', `p10 ${length.p10} ｜ p25 ${length.p25} ｜ **p50 ${length.p50}** ｜ p75 ${length.p75} ｜ p90 ${length.p90} ｜ p95 ${length.p95} ｜ max ${length.max}`, '');
lines.push('## 逗号数分位', '', `p25 ${comma.p25} ｜ **p50 ${comma.p50}** ｜ p75 ${comma.p75}`, '');
fs.writeFileSync(path.join(SKILL_DIR, 'references', 'style-ratios.md'), lines.join('\n'));

console.log(`已生成 references/style-ratios.md + data/style-ratios.json（语料 ${n} 条，${out.length} 个特征）`);
console.log(`语料溯源：${provenanceLine(info)}`);
console.log('样例：' + out.slice(0, 6).map(f => `${f.name} ${(f.p * 100).toFixed(1)}% [${(f.ci[0] * 100).toFixed(1)}–${(f.ci[1] * 100).toFixed(1)}]`).join(' ｜ '));
