#!/usr/bin/env node
/**
 * run-evals — 峰哥体行为验收运行器（v2）
 *
 * 为什么要有它：v1 的 12 条 evals 停在 2026-08-30、**从未跑过**（没有 runner、没有结果落盘）。
 * 这个 runner 把每条用例变成「机器可判」的断言，并把每次运行结果写进 evals/results.json。
 *
 * 用法：
 *   node evals/run-evals.mjs --list
 *   node evals/run-evals.mjs --id 14 --text "文案"
 *   node evals/run-evals.mjs --batch samples/out      # 目录里放 1.txt 2.txt …
 *   node evals/run-evals.mjs --selftest               # 内置反例，自检 runner 本身
 * 退出码：0 = 全过；1 = 有 FAIL
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../scripts/fengge-lint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const EVALS = JSON.parse(fs.readFileSync(path.join(HERE, 'evals.json'), 'utf8'));
const DISCLAIMER = /个人观点|个人看法|个人判断|个人猜测|不构成[^。！？]{0,8}建议|风险自担/;

function judge(c, text) {
  const lint = check(text, (c.checks && c.checks.lintVersion) || EVALS.universal.lintVersion);
  const reasons = [];
  const fails = [];

  for (const r of lint.results) if (r.level === 'FAIL') fails.push(`[lint:${r.rule}] ${r.msg}`);

  const ch = c.checks || {};
  for (const p of ch.forbid || []) if (new RegExp(p).test(text)) fails.push(`[forbid] 命中禁止项 /${p}/`);
  for (const p of ch.require || []) if (!new RegExp(p).test(text)) fails.push(`[require] 缺少必需项 /${p}/`);
  if (ch.requireDisclaimer && !DISCLAIMER.test(text)) fails.push('[require] 该条写了判断，必须挂免责声明（末句）');
  if (ch.noDisclaimer && DISCLAIMER.test(text)) fails.push('[forbid] 这条不该挂免责声明（他全量仅 0.5%）');
  if (ch.minLen && [...text.trim()].length < ch.minLen) fails.push(`[len] ${[...text.trim()].length} 字 < 下限 ${ch.minLen}`);

  return { id: c.id, pass: fails.length === 0, fails, warns: lint.warns, len: lint.len, reasons };
}

function report(res, c, quiet) {
  const head = `eval #${String(c.id).padStart(2)}  ${c.prompt.slice(0, 40)}${c.prompt.length > 40 ? '…' : ''}`;
  if (res.pass) { if (!quiet) console.log(`✓ PASS  ${head}   （${res.len} 字, WARN ${res.warns}）`); return; }
  console.log(`✗ FAIL  ${head}   （${res.len} 字）`);
  for (const f of res.fails) console.log(`         ↳ ${f}`);
}

function loadStore(f) {
  // 容错：文件可能被中断的进程写成空文件/半截 JSON
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(j.runs) ? j : { runs: [] };
  } catch {
    return { runs: [] };
  }
}

function save(entry) {
  const f = path.join(HERE, 'results.json');
  const prev = fs.existsSync(f) ? loadStore(f) : { runs: [] };
  prev.runs.push(entry);
  fs.writeFileSync(f, JSON.stringify(prev, null, 2));
  return path.relative(process.cwd(), f);
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

if (argv.includes('--list')) {
  for (const c of EVALS.evals) console.log(`#${String(c.id).padStart(2)}  ${c.prompt}`);
  process.exit(0);
}

if (argv.includes('--selftest')) {
  const SELF = [
    { id: 14, text: '一句祝福就把中秋福利顶了，为什么还有人释怀？月饼 6 折都卖不动，祝福直接 0 折。这波我不亏，红包照发。', want: true },
    { id: 14, text: '公司中秋福利换成一句祝福，我算了算，这句祝福值 0 块。你们领祝福，我发红包——8888，评论区见。个人观点，不构成中秋建议。', want: false },
    { id: 16, text: '国乒女团又拿金牌了，为什么我一点不激动？我只看我的仓位，金牌不能当饭吃。', want: false },
    { id: 18, text: '今天按峰哥的解封后配方筛掉了不能碰的（伤亡/病痛/政治），发了罗森便当那条。', want: false },
    { id: 4, text: '沪指失守 3900，我 994 一克买的黄金反倒红了。这波我不慌，仓位拿一路。个人观点，不构成投资建议。', want: true },
  ];
  let bad = 0;
  const rows = [];
  for (const s of SELF) {
    const c = EVALS.evals.find(e => e.id === s.id);
    const res = judge(c, s.text);
    const ok = res.pass === s.want;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} selftest #${s.id} 期望 ${s.want ? 'PASS' : 'FAIL'} / 实际 ${res.pass ? 'PASS' : 'FAIL'}`);
    for (const f of res.fails) console.log(`      ↳ ${f}`);
    rows.push({ id: s.id, want: s.want, got: res.pass, fails: res.fails });
  }
  const p = save({ at: new Date().toISOString(), kind: 'selftest', total: SELF.length, mismatched: bad, rows });
  console.log(`\nselftest：${SELF.length - bad}/${SELF.length} 符合预期 → ${p}`);
  process.exit(bad ? 1 : 0);
}

const id = Number(arg('--id', 0));
if (id) {
  const c = EVALS.evals.find(e => e.id === id);
  if (!c) { console.error('没有这个用例：', id); process.exit(2); }
  const file = arg('--file', null);
  const text = arg('--text', null) ?? (file ? fs.readFileSync(file, 'utf8') : null);
  if (text == null) { console.error('用法：--id N --text "..." | --file x.txt'); process.exit(2); }
  const res = judge(c, text);
  report(res, c, false);
  save({ at: new Date().toISOString(), kind: 'single', id, pass: res.pass, fails: res.fails, len: res.len });
  process.exit(res.pass ? 0 : 1);
}

const dir = arg('--batch', null);
if (dir) {
  let pass = 0, total = 0;
  const rows = [];
  for (const c of EVALS.evals) {
    const f = path.join(dir, `${c.id}.txt`);
    if (!fs.existsSync(f)) continue;
    total++;
    const res = judge(c, fs.readFileSync(f, 'utf8'));
    if (res.pass) pass++;
    report(res, c, true);
    rows.push({ id: c.id, pass: res.pass, fails: res.fails });
  }
  const p = save({ at: new Date().toISOString(), kind: 'batch', dir, total, passed: pass, rows });
  console.log(`\n批量结果：${pass}/${total} PASS → ${p}`);
  process.exit(pass === total ? 0 : 1);
}

console.log('用法：--list | --id N --text "..." | --batch <dir> | --selftest');
process.exit(2);
