#!/usr/bin/env node
/**
 * fengge-align — 把一批文案的特征分布与语料基准对齐打分。
 *
 * 用法：
 *   node scripts/fengge-align.mjs --dir <文件夹>     # 读里面所有 .txt（一行一条）
 *   node scripts/fengge-align.mjs --file a.txt ...   # 每个文件算一条
 *   node scripts/fengge-align.mjs --stdin            # 每行一条
 * 输出：逐特征对照表 + 总距离分（越小越像）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const CORPUS = 'C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_v2_raw.json';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

// —— 语料基准（只算原创非长文，与 skill 的写作目标一致）——
const arr = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const base = arr.filter(x => !x.retweeted && !x.rtText && !x.isLong).map(x => String(x.text_raw || x.text || '').trim()).filter(Boolean);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const share = (arr, f) => arr.filter(f).length / arr.length;

// —— 特征定义（每个特征给 0–1 的"像"程度，1 = 完全一致）——
const FEATURES = [
  { key: '长度中位', get: (ts) => median(ts.map(t => [...t].length)), tol: 20, weight: 1 },
  { key: '结尾不加标点', get: (ts) => share(ts, t => !/[。！？]$/.test(t.trim())), tol: 0.25, weight: 1 },
  { key: '句号收尾', get: (ts) => share(ts, t => t.trim().endsWith('。')), tol: 0.25, weight: 1 },
  { key: '含问号', get: (ts) => share(ts, t => /？/.test(t)), tol: 0.15, weight: 1 },
  { key: '逗号中位', get: (ts) => median(ts.map(t => (t.match(/，/g) || []).length)), tol: 1.5, weight: 0.7 },
  { key: '含「我」', get: (ts) => share(ts, t => /我/.test(t)), tol: 0.2, weight: 1 },
  { key: '含「你们」', get: (ts) => share(ts, t => /你们/.test(t)), tol: 0.08, weight: 1 },
  { key: '含数字', get: (ts) => share(ts, t => /\d/.test(t)), tol: 0.2, weight: 1 },
  { key: '免责句', get: (ts) => share(ts, t => /个人观点|不构成[^。！？]{0,8}建议|个人看法|个人判断/.test(t)), tol: 0.05, weight: 1 },
  { key: '你们…我…对仗', get: (ts) => share(ts, t => /你们[^。！？\n]{0,30}我/.test(t)), tol: 0.03, weight: 1 },
  { key: '假口头禅', get: (ts) => share(ts, t => /我算了|算了算|算下来|这账|算账|换算成|建议大家|建议你们|够我买|白赚|茶叶蛋|性价比|本质上/.test(t)), tol: 0.02, weight: 1 },
  { key: '顿号/分号', get: (ts) => share(ts, t => /[、；]/.test(t)), tol: 0.05, weight: 0.7 },
];

let texts = [];
const dir = arg('--dir', null);
if (dir) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.txt'))) texts.push(...fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--file') texts.push(...fs.readFileSync(process.argv[i + 1], 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
if (process.argv.includes('--stdin')) texts.push(...fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
if (!texts.length) { console.error('用法：--dir <文件夹> | --file x.txt | --stdin'); process.exit(2); }

const rows = [];
let score = 0, wsum = 0;
for (const f of FEATURES) {
  const b = f.get(base), s = f.get(texts);
  const delta = Math.abs(b - s);
  const like = Math.max(0, 1 - delta / f.tol);
  score += like * f.weight; wsum += f.weight;
  const fmt = (v) => (v <= 1 && v >= 0 && f.key !== '长度中位' && f.key !== '逗号中位' ? (v * 100).toFixed(1) + '%' : v.toFixed(2));
  rows.push({ 特征: f.key, 语料: fmt(b), 本批: fmt(s), 差: fmt(delta), 像: (like * 100).toFixed(0) + '%' });
}
const total = score / wsum;
console.log(`样本 ${texts.length} 条 ｜ 语料基准 ${base.length} 条（原创非长文）\n`);
console.log('特征'.padEnd(16) + '语料'.padEnd(10) + '本批'.padEnd(10) + '差'.padEnd(10) + '像');
for (const r of rows) console.log(r.特征.padEnd(14) + String(r.语料).padEnd(10) + String(r.本批).padEnd(10) + String(r.差).padEnd(10) + r.像);
console.log(`\n总对齐分：${(total * 100).toFixed(1)}%（100% = 每个特征都与语料一致）`);
console.log(total >= 0.85 ? '→ 分布上已经很接近' : total >= 0.7 ? '→ 大体像，仍有几个特征偏' : '→ 仍有明显系统性偏差，看"像"最低的几行');
