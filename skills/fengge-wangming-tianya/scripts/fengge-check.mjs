#!/usr/bin/env node
/**
 * fengge-check — 一键验收：改完 skill 后跑这一条，确认没退化。
 *
 *   1) lint 回归基线（历史 9 条文案）
 *   2) evals runner 自检（正例必过/反例必挂）
 *   3) 黄金批次对齐分（与语料分布的距离，低于阈值即判退化）
 *
 * 用法：node scripts/fengge-check.mjs [--min-align 0.6]
 * 退出码：0 = 全过；1 = 有退化。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const MIN_ALIGN = Number(arg('--min-align', 0.6));
const run = (script, args) => {
  try { return { ok: true, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: SKILL }) }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
};

let bad = 0;
console.log('=== 1/3 lint 回归基线（历史已发 9 条）===');
const reg = run('scripts/fengge-lint.mjs', ['--regress']);
const regLine = (reg.out.split('\n').find(l => l.includes('按新规则')) || '').trim();
console.log(regLine || reg.out.split('\n').slice(0, 3).join('\n'));
const failedMatch = regLine.match(/(\d+)\/(\d+) 条 FAIL/);
const failedShare = failedMatch ? Number(failedMatch[1]) / Number(failedMatch[2]) : 1;

console.log('\n=== 2/3 evals 自检 ===');
const ev = run('evals/run-evals.mjs', ['--selftest']);
const evLine = (ev.out.split('\n').find(l => l.includes('selftest：')) || '').trim();
console.log(evLine || ev.out.slice(0, 300));
if (!ev.ok) { console.log('✗ evals 自检未全过'); bad++; }

console.log('\n=== 3/3 黄金批次对齐分 ===');
const golden = path.join(SKILL, 'evals', 'samples', 'golden-batch.txt');
const al = run('scripts/fengge-align.mjs', ['--file', golden]);
const alLine = (al.out.split('\n').find(l => l.includes('总对齐分')) || '').trim();
console.log(alLine || al.out.slice(0, 300));
const score = Number((alLine.match(/([\d.]+)%/) || [])[1] || 0) / 100;
if (score < MIN_ALIGN) { console.log(`✗ 对齐分 ${(score * 100).toFixed(1)}% 低于阈值 ${(MIN_ALIGN * 100).toFixed(0)}%`); bad++; }

console.log('\n--- 结论 ---');
console.log(`历史文案 FAIL 率 ${(failedShare * 100).toFixed(0)}%（这批本来就该 FAIL：免责句/对仗是旧规则产物）`);
console.log(`黄金批次对齐分 ${(score * 100).toFixed(1)}%`);
if (bad) { console.log('✗ 有项目未达标'); process.exit(1); }
console.log('✓ 全部达标');
