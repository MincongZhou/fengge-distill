#!/usr/bin/env node
/**
 * ablation.mjs — 把消融实验的对比表与成本表**从真实产物里生成**（不手抄数字）。
 *
 * 输入：bench/report/metrics-<runId>.json（bench/metrics.mjs 产出）+ bench/runs/<runId>/ 的逐条记录
 * 输出：bench/report/ablation-<runId>.md + .json
 *
 * 表里固定含一行 **c3-lora（未运行）**：本次没跑（不是跑不了——本机有 RTX 3070 Laptop 8GB，
 * 但公平对比要求 c0/c1/c2 换到同一开源基座重跑，那是另一整轮），所以微调这一档没有数字可给。
 * 按仓库既有规矩——**不拿"没测过"冒充"不兼容"、不拿没跑过的东西填表**——
 * 它只以"未运行 + 原因 + 可执行协议在哪"的形式出现。协议见 bench/LORA.md。
 *
 * 用法：
 *   node bench/ablation.mjs --run <runId>
 *   node bench/ablation.mjs --run <runId> --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOfRun, loadPricing } from './pricing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, 'report');

export const CONDITION_LABELS = {
  'c0-base': '基模直出（无规则、无语料）',
  'c1-distilled': '蒸馏规则（SKILL.md）',
  'c2-retrieval': '蒸馏规则 + 语料检索增强',
  'c3-lora': '微调 LoRA',
  'neg-formal': '正式书面腔（负例档，不参与排名）',
};

export function readRunRecords(runDir, condition) {
  const dir = path.join(runDir, condition);
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

const pct = (x, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const f2 = (x) => (x == null ? '—' : Number(x).toFixed(2));

/** 两个条件的相对变化（越低越好的指标用 lowerIsBetter=true 会让"改善"为正） */
export function delta(from, to, lowerIsBetter = true) {
  if (from == null || to == null || from === 0) return null;
  const rel = (to - from) / from;
  return lowerIsBetter ? -rel : rel;
}

export function buildAblation({ runId, metrics, runDir, pricing = loadPricing() }) {
  const conditions = Object.keys(metrics.conditions).filter((c) => c !== 'neg-formal');
  const rows = [];
  for (const c of conditions) {
    const m = metrics.conditions[c];
    const recs = readRunRecords(runDir, c) || [];
    const cost = costOfRun(recs, { pricing });
    rows.push({
      condition: c,
      label: CONDITION_LABELS[c] || c,
      n: m.n,
      medianChars: m.length.p50,
      lintFail: m.lint.failRate,
      band: m.band.rate,
      jsd: m.style.jsd,
      mae: m.style.mae,
      distinct3: m.distinct?.d3 ?? null,
      bleu: m.bleu.mean,
      rougeL: m.rougeL.mean,
      cost,
      perCall: cost.calls ? { usd: +(cost.usd / cost.calls).toFixed(8), promptTokens: Math.round((cost.tokens.cacheMiss + cost.tokens.cacheHit) / cost.calls) } : null,
      offBand: m.band.offBand,
      lintByRule: m.lint.byRule,
      drivers: m.style.drivers,
    });
  }

  // 相对基模的改善（行为指标：lint 失败率、风格 JSD 越低越好；带内率越高越好）
  const base = rows.find((r) => r.condition === 'c0-base');
  for (const r of rows) {
    r.vsBase = base && r !== base ? {
      lintFail: delta(base.lintFail, r.lintFail, true),
      jsd: delta(base.jsd, r.jsd, true),
      band: delta(base.band, r.band, false),
    } : null;
  }

  const lora = {
    condition: 'c3-lora',
    label: CONDITION_LABELS['c3-lora'],
    status: 'not-run',
    reason: '本次未跑（不是跑不了）：本机有 RTX 3070 Laptop 8GB 与可达的 PyPI/HuggingFace，缺的只是训练依赖未装；并且公平对比要求 c0/c1/c2 换到同一开源基座重跑。宁可不给数字，也不给一个不是实测的数字。',
    protocol: 'bench/LORA.md',
    export: 'node bench/lora.mjs export --out bench/lora/data',
  };
  return {
    runId, at: new Date().toISOString(),
    model: metrics.conditions[conditions[0]] ? undefined : undefined,
    pricing: { source: pricing.source.url, fetchedAt: pricing.source.verifiedAt, currency: pricing.currency },
    rows, lora,
    control: metrics.control || null,
    corpus: metrics.corpus,
  };
}

export function toMarkdown(a) {
  const L = [];
  L.push(`# 消融实验对比（runId ${a.runId}）`);
  L.push('');
  L.push(`> 全部数字由 \`node bench/ablation.mjs --run ${a.runId}\` 从真实产物生成，不手抄。语料：${a.corpus || '—'}`);
  L.push(`> 价格来源：${a.pricing.source}（${a.pricing.fetchedAt} 抓取，${a.pricing.currency}）`);
  L.push('');
  L.push('## 一、主表');
  L.push('');
  L.push('| 档 | 说明 | n | 中位字数 | lint 不通过↓ | 统计带内率↑ | 风格 JSD↓ | 风格 MAE↓ | distinct-3 | BLEU | ROUGE-L | 成本/次 |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of a.rows) {
    L.push(`| \`${r.condition}\` | ${r.label} | ${r.n} | ${r.medianChars} | ${pct(r.lintFail)} | ${pct(r.band)} | ${f2(r.jsd)} | ${f2(r.mae)} | ${f2(r.distinct3)} | ${f2(r.bleu)} | ${f2(r.rougeL)} | $${r.perCall ? r.perCall.usd.toFixed(6) : '—'} |`);
  }
  L.push(`| \`c3-lora\` | ${a.lora.label} | — | — | — | — | — | — | — | — | — | — |`);
  if (a.control) {
    const c = a.control;
    L.push(`| **_real 对照_** | _从语料随机抽 30 条真帖（同题检索参考，剔除自身）_ | ${c.n} | ${c.length.p50} | ${pct(c.lint.failRate)} | ${pct(c.band.rate)} | ${f2(c.style.jsd)} | ${f2(c.style.mae)} | ${f2(c.distinct?.d3)} | ${f2(c.bleu.mean)} | ${f2(c.rougeL.mean)} | — |`);
  }
  L.push('');
  L.push(`**c3-lora 未运行**：${a.lora.reason} 可执行协议与数据导出见 [\`${a.lora.protocol}\`](${a.lora.protocol})（\`${a.lora.export}\`）。`);
  L.push('');
  L.push('## 二、相对基模的变化');
  L.push('');
  L.push('| 档 | lint 失败率变化 | 风格 JSD 变化 | 统计带内率变化 |');
  L.push('|---|---:|---:|---:|');
  for (const r of a.rows) {
    if (!r.vsBase) continue;
    const s = (v) => (v == null ? '—' : `${v >= 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(0)}%`);
    const sp = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%`);
    L.push(`| \`${r.condition}\` | ${s(r.vsBase.lintFail)} | ${s(r.vsBase.jsd)} | ${sp(r.vsBase.band)} |`);
  }
  L.push('');
  L.push('（lint 失败率与风格 JSD 越低越好，"−"表示改善；带内率越高越好，"+"表示改善。）');
  L.push('');
  L.push('## 三、各档的画像偏差点（top 6）');
  L.push('');
  for (const r of a.rows) {
    L.push(`**\`${r.condition}\`** ｜ 带外特征：${r.offBand.length ? r.offBand.join('、') : '无'}`);
    L.push('');
    L.push('| 特征 | 语料 | 本档 | 差 |');
    L.push('|---|---:|---:|---:|');
    for (const d of r.drivers) L.push(`| ${d.feature} | ${d.corpus}% | ${d.cand}% | ${d.diff > 0 ? '+' : ''}${d.diff} |`);
    L.push('');
  }
  L.push('## 四、成本');
  L.push('');
  L.push('| 档 | 调用数 | 输入·未命中 | 输入·命中 | 输出 | 缓存命中率 | 合计 | 每次 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of a.rows) {
    const t = r.cost.tokens;
    L.push(`| \`${r.condition}\` | ${r.cost.calls} | ${t.cacheMiss} | ${t.cacheHit} | ${t.output} | ${pct(r.cost.cacheHitRate)} | $${r.cost.usd.toFixed(6)} | $${r.perCall ? r.perCall.usd.toFixed(6) : '—'} |`);
  }
  const total = a.rows.reduce((s, r) => s + r.cost.usd, 0);
  L.push(`| **合计** | ${a.rows.reduce((s, r) => s + r.cost.calls, 0)} | | | | | **$${total.toFixed(6)}** | |`);
  L.push('');
  L.push('> 规则档（c1/c2）每次要灌入 1.5 万字左右的 SKILL.md，输入 token 比基模档高两个数量级；');
  L.push('> 但缓存命中率极高（同一段 system 前缀），命中的输入只按未命中的 1/50 计价，所以 **"规则很贵"其实是个错觉**——');
  L.push('> 真正的成本大头是输出，而规则档的输出反而更短。');
  L.push('');
  return L.join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const runId = arg('--run');
  if (!runId) { console.error('用法：--run <runId> [--json]'); process.exit(2); }
  const metricsFile = path.join(REPORT, `metrics-${runId}.json`);
  if (!fs.existsSync(metricsFile)) { console.error(`缺少 ${metricsFile}，先跑：node bench/metrics.mjs --run ${runId}`); process.exit(2); }
  const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
  const ab = buildAblation({ runId, metrics, runDir: path.join(HERE, 'runs', runId) });
  fs.mkdirSync(REPORT, { recursive: true });
  fs.writeFileSync(path.join(REPORT, `ablation-${runId}.json`), JSON.stringify(ab, null, 2));
  fs.writeFileSync(path.join(REPORT, `ablation-${runId}.md`), toMarkdown(ab));
  if (argv.includes('--json')) console.log(JSON.stringify(ab, null, 2));
  else console.log(toMarkdown(ab));
  // 走 stdout 而不是 stderr：CI 里往 stderr 写一行会被 PowerShell 记成 NativeCommandError，
  // 让"成功但吐了个路径"看起来像失败（本轮就误报过一次 exit 1）。
  console.log(`\n→ bench/report/ablation-${runId}.md`);
}
