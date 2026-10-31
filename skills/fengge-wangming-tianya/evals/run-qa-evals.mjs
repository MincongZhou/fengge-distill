#!/usr/bin/env node
/**
 * run-qa-evals — 文字场问答的评测运行器。
 *
 * 为什么单独一个运行器、不并进 run-evals.mjs：
 *   run-evals 判的是**发博**（走 fengge-lint），而问答体走 fengge-qa-lint——两把尺子口径相反
 *   （发博要"绕回我"，聊天要"没有我"）。混在一个 judge 里最容易出的错就是拿错尺子。
 *
 * 判据分两层：
 *   ① 通用形态 → scripts/fengge-qa-lint.mjs（长度带 / 短答无主语 / 硬格式 / 客服腔 / 建议 /
 *      荐股带单 / 冒充 / 表情 / 长答三段 / 免责挂载）
 *   ② 本题专属 → qa-evals.json 的 checks.forbid / checks.require
 *
 * 用法：
 *   node evals/run-qa-evals.mjs --list
 *   node evals/run-qa-evals.mjs --id q05 --text "平平安安健健康康比啥都强"
 *   node evals/run-qa-evals.mjs --batch samples/qa-baseline.txt     # 第 N 行 ↔ 第 N 题
 *   node evals/run-qa-evals.mjs --selftest                          # 转调 qa-lint 自检
 * 退出码：0 = 全过；1 = 有 FAIL
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkQA, runSelftest } from '../scripts/fengge-qa-lint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const QA_EVALS = JSON.parse(fs.readFileSync(path.join(HERE, 'qa-evals.json'), 'utf8'));

/** 判一条：qa-lint + 题专属 checks */
export function judgeQA(c, text) {
  const rep = checkQA(text, c.kind);
  const fails = rep.results.filter((r) => r.level === 'FAIL').map((r) => `[${r.rule}] ${r.msg}`);
  const ch = c.checks || {};
  for (const p of ch.forbid || []) if (new RegExp(p).test(text)) fails.push(`[forbid] 命中本题禁止项 /${p}/`);
  for (const p of ch.require || []) if (!new RegExp(p).test(text)) fails.push(`[require] 缺少本题必需项 /${p}/`);
  return { id: c.id, kind: c.kind, pass: fails.length === 0, fails, warns: rep.warns, len: rep.len };
}

/** 跑一个文件：第 N 条非空行对应第 N 题 */
export function runBatch(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((s) => s.replace(/\r$/, '').trim()).filter(Boolean);
  const rows = [];
  for (let i = 0; i < Math.min(lines.length, QA_EVALS.evals.length); i++) rows.push(judgeQA(QA_EVALS.evals[i], lines[i]));
  return { rows, total: rows.length, passed: rows.filter((r) => r.pass).length, expected: QA_EVALS.evals.length };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

  if (argv.includes('--list')) {
    for (const c of QA_EVALS.evals) console.log(`${c.id}  [${c.kind.padEnd(5)}] ${c.prompt}`);
    process.exit(0);
  }

  if (argv.includes('--selftest')) {
    const r = runSelftest();
    console.log(`\nqa-lint selftest：${r.total - r.mismatched}/${r.total} 符合预期`);
    process.exit(r.mismatched ? 1 : 0);
  }

  const file = arg('--batch', null);
  if (file) {
    const r = runBatch(file);
    for (const row of r.rows) {
      if (row.pass) { console.log(`✓ ${row.id}（${row.kind}，${row.len} 字）`); continue; }
      console.log(`✗ ${row.id}（${row.kind}，${row.len} 字）`);
      for (const f of row.fails) console.log(`    ↳ ${f}`);
    }
    console.log(`\n批量：${r.passed}/${r.total} PASS（题库 ${r.expected} 题）`);
    process.exit(r.passed === r.total && r.total === r.expected ? 0 : 1);
  }

  const id = arg('--id', null);
  if (id) {
    const c = QA_EVALS.evals.find((e) => e.id === id);
    if (!c) { console.error(`没有这个用例：${id}（用 --list 看全部）`); process.exit(2); }
    const text = arg('--text', null) ?? (arg('--file', null) ? fs.readFileSync(arg('--file'), 'utf8') : null);
    if (text == null) { console.error('用法：--id q05 --text "…" | --file x.txt'); process.exit(2); }
    const r = judgeQA(c, text);
    console.log(`题：${c.prompt}\n期望：${c.expected_output}\n`);
    console.log(r.pass ? `✓ PASS（${r.kind}，${r.len} 字）` : `✗ FAIL（${r.kind}，${r.len} 字）`);
    for (const f of r.fails) console.log(`  ↳ ${f}`);
    process.exit(r.pass ? 0 : 1);
  }

  console.error('用法：--list | --id q05 --text "…" | --batch <file> | --selftest');
  process.exit(2);
}
