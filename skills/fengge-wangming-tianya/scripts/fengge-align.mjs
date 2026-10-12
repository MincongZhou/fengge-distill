#!/usr/bin/env node
/**
 * fengge-align — 把一批文案与语料基准做**统计对齐**（不再用拍脑袋的容差）。
 *
 * 判据：
 *   比例类特征 —— 合成 95% 区间：p ± 1.96·sqrt(p(1−p)/n_语料 + p(1−p)/m_批次)
 *                 落在带内 = 像；超出 = 偏（并给出偏的方向）
 *   中位数类   —— 落在语料 p25–p75 之间 = 像
 *
 * 用法：
 *   node scripts/fengge-align.mjs --dir <文件夹> | --file a.txt ... | --stdin
 *   node scripts/fengge-align.mjs --file x.txt --json
 * 前置：先跑 scripts/fengge-ratio.mjs 生成 data/style-ratios.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIGN_FEATURES, matcherFor } from './style-features.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const RATIO_FILE = path.join(SKILL_DIR, 'data', 'style-ratios.json');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

// 这里**不再读语料**：旧版为了算「逗号中位带」回头读 fg_fengge_v2_raw.json，
// 而那个路径写死在本机，于是 align / accept 换台机器就崩、也进不了 CI。
// 现在逗号分位由 fengge-ratio.mjs 在生成基准时一并落盘（style-ratios.json 的 comma 段），
// align 变成一个**只依赖仓库内文件**的纯函数——这是它能进 CI 的前提。
if (!fs.existsSync(RATIO_FILE)) { console.error('缺少 data/style-ratios.json，先跑：node scripts/fengge-ratio.mjs'); process.exit(2); }
const R = JSON.parse(fs.readFileSync(RATIO_FILE, 'utf8'));
const N = R.n;
const byName = Object.fromEntries(R.features.map(f => [f.name, f]));

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
// 逗号中位带来自基准文件；旧基准没有 comma 段时给 null，由调用方标注「未判」而不是拿 0 冒充。
const commaBand = R.comma ? [R.comma.p25, R.comma.p75] : null;
const commaBase = R.comma ? R.comma.p50 : null;

// 特征名与判定器都来自 style-features.mjs 的单一来源（这里以前各自抄了一份 28 条正则，
// 和 ratio 的 40 条对不上——改一处忘一处就会"基准说 A、对齐判 B"）。
const PROPS = ALIGN_FEATURES;

export function alignTexts(texts) {
  const m = texts.length;
  const rows = [];
  let inBand = 0, judged = 0;
  for (const name of PROPS) {
    const f = byName[name]; if (!f) continue;
    const re = matcherFor(name);
    const k = texts.filter(t => (typeof re === 'function' ? re(t) : re.test(t))).length;
    const q = k / m;
    const p = f.p;
    const se = Math.sqrt(p * (1 - p) / N + p * (1 - p) / m);
    const lo = Math.max(0, p - 1.96 * se), hi = Math.min(1, p + 1.96 * se);
    const ok = q >= lo && q <= hi;
    judged++; if (ok) inBand++;
    rows.push({ 特征: name, 语料: (p * 100).toFixed(1) + '%', 允许带: `${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%`, 本批: (q * 100).toFixed(1) + `% (${k}/${m})`, 判定: ok ? '✓' : (q > hi ? '↑偏高' : '↓偏低') });
  }
  const meds = [
    { 特征: '长度中位', 语料: R.length.p50, 带: `${R.length.p25}–${R.length.p75}`, 值: median(texts.map(t => [...t].length)) },
    ...(commaBand ? [{ 特征: '逗号中位', 语料: commaBase, 带: `${commaBand[0]}–${commaBand[1]}`, 值: median(texts.map(t => (t.match(/，/g) || []).length)) }] : []),
  ];
  const medRows = meds.map(x => {
    const ok = x.值 >= Number(x.带.split('–')[0]) && x.值 <= Number(x.带.split('–')[1]);
    judged++; if (ok) inBand++;
    return { 特征: x.特征, 语料: String(x.语料), 允许带: x.带, 本批: String(x.值), 判定: ok ? '✓' : (x.值 > Number(x.带.split('–')[1]) ? '↑偏高' : '↓偏低') };
  });
  return { n: m, rows: [...medRows, ...rows], judged, inBand, score: inBand / judged };
}

function readInputs() {
  const texts = [];
  const dir = arg('--dir', null);
  if (dir) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.txt'))) texts.push(...fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--file') texts.push(...fs.readFileSync(process.argv[i + 1], 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
  if (process.argv.includes('--stdin')) texts.push(...fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
  return texts;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const texts = readInputs();
  if (!texts.length) { console.error('用法：--dir <文件夹> | --file x.txt | --stdin'); process.exit(2); }
  const rep = alignTexts(texts);
  const { n: m, rows, judged, inBand, score } = rep;

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    console.log(`样本 ${m} 条 ｜ 语料基准 ${N} 条（原创非长文）｜ 判据：合成 95% 区间 + p25–p75\n`);
    console.log('特征'.padEnd(18) + '语料'.padEnd(9) + '允许带'.padEnd(15) + '本批'.padEnd(14) + '判定');
    for (const r of rows) console.log(String(r.特征).padEnd(16) + r.语料.padEnd(9) + r.允许带.padEnd(15) + r.本批.padEnd(14) + r.判定);
    console.log(`\n带内比例：${inBand}/${judged} = ${(score * 100).toFixed(0)}%`);
    if (m < 20) console.log(`⚠️ 样本 ${m} 条偏小：允许带已按样本量放宽，但结论仍不如 30+ 条稳。`);
    console.log(score >= 0.85 ? '→ 统计上已与语料同期分布' : score >= 0.7 ? '→ 大体同分布，个别特征偏' : '→ 明显偏离，看 ↑↓ 那几行');
  }
}
