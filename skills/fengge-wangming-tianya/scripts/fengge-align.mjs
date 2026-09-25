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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const RATIO_FILE = path.join(SKILL_DIR, 'data', 'style-ratios.json');
const CORPUS = 'C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_v2_raw.json';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

if (!fs.existsSync(RATIO_FILE)) { console.error('缺少 data/style-ratios.json，先跑：node scripts/fengge-ratio.mjs'); process.exit(2); }
const R = JSON.parse(fs.readFileSync(RATIO_FILE, 'utf8'));
const N = R.n;
const byName = Object.fromEntries(R.features.map(f => [f.name, f]));

// 复算语料的中位数类基准（逗号数）
const arr = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const base = arr.filter(x => !x.retweeted && !x.rtText && !x.isLong).map(x => String(x.text_raw || x.text || '').trim()).filter(Boolean);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const commaCounts = base.map(t => (t.match(/，/g) || []).length).sort((a, b) => a - b);
const commaBand = [commaCounts[Math.floor(N * .25)], commaCounts[Math.floor(N * .75)]];

const PROPS = ['含「我」', '含「你」', '含「你们」', '含问号', '含数字', '含话题标签', '免责句', '你们…我…对仗', '假口头禅', '顿号/分号', '换行', '方括号表情', '结尾不加标点', '句号收尾', '感叹号收尾', '问号收尾', '以「我」开头', '以「峰哥」开头', '含「为什么」', '含「太吓人了」', '含「家人们」', '含「满仓」', '含「割肉」', '含「抽奖」', '极短帖(≤14字)', '短帖(15-50)', '中帖(51-103)', '长帖(>103)'];
const RE = {
  '含「我」': /我/, '含「你」': /你/, '含「你们」': /你们/, '含问号': /？/, '含数字': /\d/, '含话题标签': /#[^#\n]{2,}#/,
  '免责句': /个人观点|不构成[^。！？]{0,8}建议|个人看法|个人判断|个人猜测/, '你们…我…对仗': /你们[^。！？\n]{0,30}我/,
  '假口头禅': /我算了|算了算|算下来|这账|算账|换算成|建议大家|建议你们|够我买|白赚|茶叶蛋|性价比|本质上/,
  '顿号/分号': /[、；]/, '换行': /\n/, '方括号表情': /\[[^\]\s]{1,6}\]/, '结尾不加标点': /[^。！？]$/,
  '句号收尾': /。$/, '感叹号收尾': /！$/, '问号收尾': /？$/, '以「我」开头': /^我/, '以「峰哥」开头': /^峰哥/,
  '含「为什么」': /为什么/, '含「太吓人了」': /太吓人了/, '含「家人们」': /家人们/, '含「满仓」': /满仓/,
  '含「割肉」': /割肉/, '含「抽奖」': /抽奖/,
  '极短帖(≤14字)': (t) => [...t].length <= 14, '短帖(15-50)': (t) => [...t].length >= 15 && [...t].length <= 50,
  '中帖(51-103)': (t) => [...t].length >= 51 && [...t].length <= 103, '长帖(>103)': (t) => [...t].length > 103,
};

export function alignTexts(texts) {
  const m = texts.length;
  const rows = [];
  let inBand = 0, judged = 0;
  for (const name of PROPS) {
    const f = byName[name]; if (!f) continue;
    const re = RE[name];
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
    { 特征: '逗号中位', 语料: median(commaCounts), 带: `${commaBand[0]}–${commaBand[1]}`, 值: median(texts.map(t => (t.match(/，/g) || []).length)) },
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
