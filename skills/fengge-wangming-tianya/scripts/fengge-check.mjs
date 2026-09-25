#!/usr/bin/env node
/**
 * fengge-check — 一键验收：改完 skill 后跑这一条，确认没退化。
 *
 *   1) lint 回归基线（历史 9 条文案）
 *   2) evals runner 自检（正例必过/反例必挂）
 *   3) 黄金批次统计对齐（与语料分布的合成 95% 区间比对）
 *
 * 实现上**直接 import 各模块**，不 spawn 子进程——商店的静态安全扫描会把子进程能力标为警告，而这里本来就不需要进程隔离。
 *
 * 用法：node scripts/fengge-check.mjs [--min-align 0.85]
 * 退出码：0 = 全过；1 = 有退化。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regressData } from './fengge-lint.mjs';
import { alignTexts } from './fengge-align.mjs';
import { runSelftest } from '../evals/run-evals.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MIN_ALIGN = Number(arg('--min-align', 0.85));

let bad = 0;

console.log('=== 1/3 lint 回归基线（历史已发 9 条）===');
const reg = regressData();
console.log(`按新规则：${reg.failed}/${reg.total} 条 FAIL，其中挂免责声明的：${reg.withDis}/${reg.total}`);
console.log(`（这批本来就该 FAIL：免责句/对仗是旧规则产物；逐条明细用 --regress）`);

console.log('\n=== 2/3 evals 自检 ===');
const ev = runSelftest({ verbose: false });
console.log(`selftest：${ev.total - ev.mismatched}/${ev.total} 符合预期 → ${ev.saved}`);
if (ev.mismatched) { console.log('✗ evals 自检未全过'); bad++; }

console.log('\n=== 3/3 黄金批次统计对齐 ===');
const golden = path.join(SKILL, 'evals', 'samples', 'golden-batch.txt');
const texts = fs.readFileSync(golden, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const al = alignTexts(texts);
const outRows = al.rows.filter(r => r.判定 !== '✓');
console.log(`样本 ${al.n} 条 ｜ 带内比例：${al.inBand}/${al.judged} = ${(al.score * 100).toFixed(0)}%`);
if (outRows.length) for (const r of outRows) console.log(`  ${r.判定}  ${r.特征}：语料 ${r.语料} / 允许带 ${r.允许带} / 本批 ${r.本批}`);
if (al.score < MIN_ALIGN) { console.log(`✗ 带内比例 ${(al.score * 100).toFixed(0)}% 低于阈值 ${(MIN_ALIGN * 100).toFixed(0)}%`); bad++; }

console.log('\n--- 结论 ---');
console.log(`历史文案 FAIL 率 ${(reg.failed / reg.total * 100).toFixed(0)}%`);
console.log(`黄金批次统计带内比例 ${(al.score * 100).toFixed(0)}%（阈值 ${(MIN_ALIGN * 100).toFixed(0)}%）`);
if (bad) { console.log('✗ 有项目未达标'); process.exit(1); }
console.log('✓ 全部达标');
