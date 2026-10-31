#!/usr/bin/env node
/**
 * metrics.mjs — 峰哥体评测的**自动指标**（包外脚本，纯本地计算，不联网）。
 *
 * 六个指标，各管一件事，别指望任何一个能单独回答"像不像"：
 *   ① lintFailRate   这套 skill 自己的规则，有多少条没过（行为指标，与 skill 契约直接挂钩）
 *   ② bandRate       与语料分布的统计带内比例（复用 fengge-align 的合成区间，同一把尺子）
 *   ③ styleJSD       40 维特征画像与语料的 JS 散度（看"画像形状"差多少，对整体高低不敏感）
 *   ④ styleMAE       同一批特征的平均绝对差（对高低敏感，和 ③ 互补）
 *   ⑤ diversity      组内两两 char-trigram Jaccard（检索增强会不会把输出写成一个模子）
 *   ⑥ bleu/rougeL    与"同题检索到的真实语料"的字面重合度
 *
 * 关于 BLEU/ROUGE 的**诚实边界**（必须读）：
 *   这套任务是开放式风格写作，没有唯一参考答案，BLEU/ROUGE 测的是**字面重合**而非风格。
 *   所以本文件一律同时输出 **real 对照**：拿真实语料里的帖子当候选、去和"另外一些真实语料"
 *   比 BLEU/ROUGE —— 那是这个指标在这项任务上的**上限**。若生成档的 BLEU 与 real 对照同量级，
 *   说明 BLEU 在这项任务上**没有区分力**，不要拿它的高低下结论。报告里会显式打印这条判断。
 *
 * 用法：
 *   node bench/metrics.mjs --run <runId>              # 跑某次生成的全部条件
 *   node bench/metrics.mjs --run <runId> --conditions c0-base,c1-distilled
 *   node bench/metrics.mjs --text-file a.txt          # 一行一条的批文本
 *   node bench/metrics.mjs --run <runId> --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, ALIGN_FEATURES, matcherFor } from '../skills/fengge-wangming-tianya/scripts/style-features.mjs';
import { check } from '../skills/fengge-wangming-tianya/scripts/fengge-lint.mjs';
import { alignTexts } from '../skills/fengge-wangming-tianya/scripts/fengge-align.mjs';
import { indexFromCorpus, retrieve } from '../skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs';
import { loadWeiboAll, sourcesLine } from '../skills/fengge-wangming-tianya/scripts/corpus-path.mjs';
import { makeSampler, sampleIndices } from './items.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SKILL = path.join(REPO, 'skills', 'fengge-wangming-tianya');
const RATIO_FILE = path.join(SKILL, 'data', 'style-ratios.json');
export const REF_K = 8;

// ---------------------------------------------------------------- 纯函数指标

/** 字符 n-gram 计数（含边界填充，避免短句 n-gram 数为 0） */
export function charNgrams(text, n) {
  const chars = [...String(text)];
  const m = new Map();
  for (let i = 0; i + n <= chars.length; i++) {
    const g = chars.slice(i, i + n).join('');
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/**
 * 字符级 corpus BLEU（n=1..maxN，几何平均 + brevity penalty）。
 * 参考侧 n-gram 表按 (n, ref) 预建一次——否则每个候选 n-gram 都要把 8 条参考重算一遍。
 * @returns {{bleu:number, precisions:number[], bp:number, candLen:number}}
 */
export function charBleu(candidate, references, { maxN = 4 } = {}) {
  const candLen = [...String(candidate)].length;
  if (!candLen || !references.length) return { bleu: 0, precisions: [], bp: 0, candLen };
  const precisions = [];
  for (let n = 1; n <= maxN; n++) {
    const refMaps = references.map((r) => charNgrams(r, n));
    const cand = charNgrams(candidate, n);
    let total = 0, matched = 0;
    for (const [g, c] of cand) {
      total += c;
      // 多参考：每个 n-gram 取"在任一参考里的最大计数"，避免参考多反而罚精度
      let best = 0;
      for (const m of refMaps) best = Math.max(best, m.get(g) || 0);
      matched += Math.min(c, best);
    }
    precisions.push(total ? matched / total : 0);
  }
  const refLen = Math.min(...references.map((r) => [...String(r)].length));
  const bp = candLen > refLen ? 1 : Math.exp(1 - refLen / candLen);
  // 任一阶精度为 0 → 几何平均为 0（标准 corpus BLEU 行为，不做平滑）
  const bleu = precisions.some((p) => p === 0) ? 0 : bp * Math.exp(precisions.reduce((a, p) => a + Math.log(p), 0) / maxN);
  return { bleu: +bleu.toFixed(4), precisions: precisions.map((p) => +p.toFixed(4)), bp: +bp.toFixed(4), candLen };
}

/** 字符级 ROUGE-L（LCS 的 F1） */
export function rougeL(candidate, reference) {
  const a = [...String(candidate)], b = [...String(reference)];
  if (!a.length || !b.length) return { p: 0, r: 0, f: 0 };
  const prev = new Array(b.length + 1).fill(0);
  let lcs = 0;
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  lcs = prev[b.length];
  const p = lcs / a.length, r = lcs / b.length;
  const f = p + r ? (2 * p * r) / (p + r) : 0;
  return { p: +p.toFixed(4), r: +r.toFixed(4), f: +f.toFixed(4), lcs };
}

/** Jensen-Shannon 散度（以 2 为底，单位 bit，范围 [0,1]） */
export function jsd(p, q) {
  const norm = (a) => { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map((v) => v / s); };
  const P = norm(p), Q = norm(q);
  const M = P.map((v, i) => (v + Q[i]) / 2);
  const kl = (A, B) => A.reduce((s, v, i) => (v > 0 ? s + v * Math.log2(v / (B[i] || 1e-12)) : s), 0);
  return +(0.5 * kl(P, M) + 0.5 * kl(Q, M)).toFixed(4);
}

/** 一批文本的 40 维特征比例向量 */
export function featureVector(texts, names = FEATURES.map((f) => f[0])) {
  return names.map((name) => {
    const m = matcherFor(name);
    const k = texts.filter((t) => (typeof m === 'function' ? m(t) : m.test(t))).length;
    return texts.length ? k / texts.length : 0;
  });
}

/** 最长公共子串（连续）——照抄检测用。返回 {len, text} */
export function longestCommonSubstring(a, b) {
  const A = [...String(a)], B = [...String(b)];
  if (!A.length || !B.length) return { len: 0, text: '' };
  let best = 0, endA = 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) { best = cur[j]; endA = i; }
      }
    }
    prev = cur;
  }
  return { len: best, text: A.slice(endA - best, endA).join('') };
}

/**
 * 照抄/记忆检测：每条文本在语料里能找到的**最长连续片段**有多长。
 * 为什么必须测：检索增强会把真实语料直接塞进 prompt，微调更是把语料权重压进模型——
 * 两条路都可能让"像他"退化成"抄他"。这份数字是 c2 档能不能算"风格模仿"而不是"复制"的底线证据，
 * 也是 bench/LORA.md 里那条"照抄率必须与提示法同档"验收标准的同一把尺子。
 */
export function verbatimCheck(texts, corpusTexts, { minReport = 6 } = {}) {
  const rows = texts.map((t) => {
    let worst = { len: 0, text: '', source: '' };
    for (const c of corpusTexts) {
      if (c === t) continue;      // 真帖自己就在语料池里；不跳过的话 real 对照会恒等于整条长度，失去对照意义
      const m = longestCommonSubstring(t, c);
      if (m.len > worst.len) worst = { ...m, source: c };
    }
    return { len: worst.len, snippet: worst.text, source: worst.source.slice(0, 40) };
  });
  const lens = rows.map((r) => r.len);
  return {
    maxLen: Math.max(0, ...lens),
    meanLen: +(lens.reduce((a, b) => a + b, 0) / (lens.length || 1)).toFixed(1),
    over10: rows.filter((r) => r.len >= 10).length,
    over15: rows.filter((r) => r.len >= 15).length,
    worst: rows.slice().sort((a, b) => b.len - a.len).slice(0, 3).filter((r) => r.len >= minReport),
    note: `最长连续照抄片段（与语料任一条比）。他本人帖子之间也会有共同套语，所以判读要跟 real 对照比，不看绝对值。`,
  };
}

/** 组内多样性：两两 char-trigram Jaccard 的均值（1=完全不同，0=全一样）
 *  注意：不同题目之间本来就几乎不共享 trigram，实测各档都在 0.00–0.02，
 *  **这项在 30 题规模上没有区分力**，只作为"有没有整批撞车"的兜底信号。 */
export function diversity(texts) {
  const sets = texts.map((t) => new Set([...charNgrams(t, 3).keys()]));
  let sum = 0, pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let inter = 0;
      const [small, big] = sets[i].size <= sets[j].size ? [sets[i], sets[j]] : [sets[j], sets[i]];
      for (const g of small) if (big.has(g)) inter++;
      const union = sets[i].size + sets[j].size - inter;
      sum += union ? inter / union : 0;
      pairs++;
    }
  }
  return pairs ? +(sum / pairs).toFixed(4) : 0;
}

/**
 * distinct-n：批内 n-gram 去重率 = 唯一 n-gram / 全部 n-gram。
 * 这是"套话化"的可用信号：一堆相似的帖子会把 distinct-3 拉低
 * （高值=用词更散，不代表更好；低值=整批在复读同一批句式）。
 */
export function distinctN(texts, maxN = 3) {
  const out = {};
  for (let n = 1; n <= maxN; n++) {
    let total = 0;
    const uniq = new Set();
    for (const t of texts) for (const [g, c] of charNgrams(t, n)) { total += c; uniq.add(g); }
    out[`d${n}`] = total ? +(uniq.size / total).toFixed(4) : 0;
  }
  return out;
}

export function lengthStats(texts) {
  const lens = texts.map((t) => [...t].length).sort((a, b) => a - b);
  const q = (x) => lens[Math.min(lens.length - 1, Math.floor(lens.length * x))] ?? 0;
  return {
    n: lens.length, p10: q(.1), p25: q(.25), p50: q(.5), p75: q(.75), p90: q(.9),
    max: lens[lens.length - 1] ?? 0,
    mean: lens.length ? +(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1) : 0,
  };
}

// ---------------------------------------------------------------- 组合指标

/**
 * 对一个条件的一批文本做完整评测。
 * @param {object} o
 * @param {string[]} o.texts
 * @param {Array<{text:string}>} [o.refsPool]  参考池（通常是全部可检索真实语料）；缺省则用同题检索
 * @param {Array<{text:string}>} [o.topics]    与 texts 一一对应的题目（用于同题检索参考）
 * @param {object} [o.retriever]               indexFromCorpus 的产物
 * @param {object} [o.ratio]                   style-ratios.json
 */
export function evaluateCondition({ texts, refsPool = null, topics = null, retriever = null, ratio } = {}) {
  const R = ratio || JSON.parse(fs.readFileSync(RATIO_FILE, 'utf8'));
  const refNames = R.features.map((f) => f.name);
  const corpusVec = R.features.map((f) => f.p);
  const candVec = featureVector(texts, refNames);

  const band = alignTexts(texts);
  const lintRows = texts.map((t) => check(t, '2026'));
  const failCounts = {};
  for (const r of lintRows) for (const x of r.results) if (x.level === 'FAIL') failCounts[x.rule] = (failCounts[x.rule] || 0) + 1;

  // BLEU/ROUGE：优先"同题检索到的真实语料"当参考；没有题目就用参考池随机前 K 条
  const refs = texts.map((t, i) => {
    const topic = topics && topics[i] ? (topics[i].topic ?? topics[i]) : null;
    if (retriever && topic) return retrieve(retriever, topic, REF_K).map((h) => h.text).filter((x) => x !== t);
    if (refsPool) return refsPool.slice(0, REF_K).map((x) => x.text).filter((x) => x !== t);
    return [];
  });

  const bleus = texts.map((t, i) => charBleu(t, refs[i]).bleu);
  const rouges = texts.map((t, i) => {
    const rs = refs[i].map((r) => rougeL(t, r).f);
    return rs.length ? Math.max(...rs) : 0;      // 取最好的一条参考，避免参考质量污染均值
  });

  const diffs = candVec.map((v, i) => v - corpusVec[i]);
  const mae = +(diffs.reduce((a, d) => a + Math.abs(d), 0) / diffs.length).toFixed(4);
  const drivers = diffs
    .map((d, i) => ({ feature: refNames[i], corpus: +(corpusVec[i] * 100).toFixed(1), cand: +(candVec[i] * 100).toFixed(1), diff: +(d * 100).toFixed(1) }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 6);

  return {
    n: texts.length,
    length: lengthStats(texts),
    lint: {
      failRate: +(lintRows.filter((r) => r.fails > 0).length / (texts.length || 1)).toFixed(4),
      warnRate: +(lintRows.filter((r) => r.warns > 0).length / (texts.length || 1)).toFixed(4),
      byRule: failCounts,
    },
    band: { judged: band.judged, inBand: band.inBand, rate: +band.score.toFixed(4), offBand: band.rows.filter((r) => r.判定 !== '✓').map((r) => r.特征) },
    style: { jsd: jsd(candVec, corpusVec), mae, drivers },
    diversity: diversity(texts),
    distinct: distinctN(texts, 3),
    // 照抄检测只在拿到语料池时才算（真帖与自身比会是满分，故 real 对照这栏要按"剔除自身"读，见 CLI 注释）
    verbatim: retriever ? verbatimCheck(texts, retriever.texts) : null,
    bleu: { mean: +(bleus.reduce((a, b) => a + b, 0) / (texts.length || 1)).toFixed(4), values: bleus },
    rougeL: { mean: +(rouges.reduce((a, b) => a + b, 0) / (texts.length || 1)).toFixed(4), values: rouges },
  };
}

/**
 * real 对照：从真实语料抽 n 条，按**自身文本**去语料里检索参考（剔除自身），算同一批指标。
 * 这是 BLEU/ROUGE 在这项任务上的上限——用来判断这两个指标有没有区分力。
 * 抽样复用 items.mjs 里那一份**取高位**的 LCG：以前这里自己写了一份 `x % len`，
 * 低位退化会让"随机抽样"偏到一小撮帖子上，而对照本身偏了就失去对照意义。
 */
export function realControl(arr, { n = 30, seed = 20261012 } = {}) {
  const retriever = indexFromCorpus(arr);
  const pool = retriever.texts;
  const rand = makeSampler(seed);
  const picked = sampleIndices(pool.length, n, rand).map((i) => ({ topic: pool[i], text: pool[i] }));
  return { ...evaluateCondition({ texts: picked.map((p) => p.text), topics: picked, retriever }), sampled: picked.length };
}

// ---------------------------------------------------------------- CLI

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const json = argv.includes('--json');

  const runId = arg('--run');
  const fileArg = arg('--text-file');
  const ratio = JSON.parse(fs.readFileSync(RATIO_FILE, 'utf8'));
  const conditionsWanted = arg('--conditions') ? arg('--conditions').split(',').map((s) => s.trim()) : null;

  const out = { at: new Date().toISOString(), runId: runId || null, ratioProvenance: ratio.provenance, conditions: {} };

  if (runId) {
    const runDir = path.join(HERE, 'runs', runId);
    if (!fs.existsSync(runDir)) { console.error(`没有这次运行：${runDir}`); process.exit(2); }
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
    // 合并语料（主流 + 三期增量）：real 对照与同题参考都取自这批，跟 fengge-retrieve 保持同一个"语料"概念
    const corpus = loadWeiboAll({ argv });
    const retriever = indexFromCorpus(corpus.data);
    const prompts = fs.readFileSync(path.join(HERE, 'prompts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const byId = Object.fromEntries(prompts.map((p) => [p.id, p]));

    const conds = conditionsWanted || manifest.conditions;
    for (const c of conds) {
      const dir = path.join(runDir, c);
      if (!fs.existsSync(dir)) { console.error(`（跳过 ${c}：这次运行没有该条件）`); continue; }
      const recs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      const texts = recs.map((r) => r.text);
      const topics = recs.map((r) => byId[r.id]);
      out.conditions[c] = { label: manifest.conditions.length ? c : c, ...evaluateCondition({ texts, topics, retriever, ratio }) };
    }
    out.corpus = sourcesLine(corpus);
    out.corpusSources = corpus.sources;
    out.corpusStats = corpus.stats;
    out.control = realControl(corpus.data, { n: 30 });
  } else if (fileArg) {
    const texts = fs.readFileSync(fileArg, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    out.conditions['(file)'] = { label: fileArg, ...evaluateCondition({ texts, ratio }) };
    // --text-file 不给参考池，所以 BLEU / ROUGE-L 恒为 0。这是**信息缺失**，不是指标算错——
    // 不写清楚的话，CI 日志里那两列 0.00 会被读成"这个指标坏了"。
    out.note = '--text-file 模式没有参考文本：BLEU / ROUGE-L / 最长照抄恒为 0（需要 --run 或提供参考池）。其余指标有效。';
  } else {
    console.error('用法：--run <runId> | --text-file <path> [--conditions a,b] [--json]');
    process.exit(2);
  }

  fs.mkdirSync(path.join(HERE, 'report'), { recursive: true });
  const reportName = runId ? `metrics-${runId}.json` : `metrics-${path.basename(fileArg, '.txt')}.json`;
  fs.writeFileSync(path.join(HERE, 'report', reportName), JSON.stringify(out, null, 2));

  if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n = 2) => Number(v).toFixed(n);
  console.log(`自动指标 ｜ 语料 ${out.corpus || '未加载'} ｜ 基准 ${ratio.provenance?.name} sha256 ${(ratio.provenance?.sha256 || '').slice(0, 12)}…\n`);
  console.log(pad('条件', 16) + pad('n', 4) + pad('中位字数', 9) + pad('lint不通过', 11) + pad('带内率', 8) + pad('风格JSD', 9) + pad('风格MAE', 9) + pad('distinct3', 10) + pad('BLEU', 7) + pad('ROUGE-L', 8) + pad('最长照抄', 9));
  for (const [c, r] of Object.entries(out.conditions)) {
    console.log(pad(c, 16) + pad(r.n, 4) + pad(r.length.p50, 9) + pad(`${(r.lint.failRate * 100).toFixed(0)}%`, 11)
      + pad(`${(r.band.rate * 100).toFixed(0)}%`, 8) + pad(num(r.style.jsd), 9) + pad(num(r.style.mae), 9)
      + pad(num(r.distinct.d3), 10) + pad(num(r.bleu.mean), 7) + pad(num(r.rougeL.mean), 8)
      + pad(r.verbatim ? `${r.verbatim.maxLen}字` : '—', 9));
  }
  if (out.control) {
    const r = out.control;
    console.log(pad('【real 对照】', 16) + pad(r.n, 4) + pad(r.length.p50, 9) + pad(`${(r.lint.failRate * 100).toFixed(0)}%`, 11)
      + pad(`${(r.band.rate * 100).toFixed(0)}%`, 8) + pad(num(r.style.jsd), 9) + pad(num(r.style.mae), 9)
      + pad(num(r.distinct.d3), 10) + pad(num(r.bleu.mean), 7) + pad(num(r.rougeL.mean), 8)
      + pad(r.verbatim ? `${r.verbatim.maxLen}字` : '—', 9));
  }
  console.log('\n最长照抄：本条与语料任一条的**最长连续公共片段**（按批次取最大值）。');
  console.log('  ⚠️ real 对照这栏天然偏高——语料里有近似重复帖（同一句发过两遍），');
  console.log('     所以判读方式是"生成档与 real 对照比"，不是"绝对值小就好"。');

  console.log('\n--- 读法与边界 ---');
  if (out.note) console.log('· ' + out.note);
  console.log('· lint不通过 = 这套 skill 自己的规则没过的比例（行为指标，越低越好）。');
  console.log('· 带内率 = 与语料 40 维画像的合成 95% 区间带内比例（复用 fengge-align，同一把尺子）。');
  console.log('· 风格JSD 对整体高低不敏感、MAE 敏感；两个一起看，再看各条件的 top 偏差点。');
  if (out.control) {
    const gen = Object.entries(out.conditions);
    const best = gen.length ? Math.max(...gen.map(([, r]) => r.bleu.mean)) : 0;
    const ctrl = out.control.bleu.mean;
    console.log(`· BLEU 区分力自检：real 对照 ${num(ctrl)} vs 生成最高 ${num(best)}。`);
    console.log(ctrl === 0 && best === 0
      ? '  → 两边都是 0：BLEU 在开放式风格写作上**没有区分力**，报告里只作为"字面重合极低"的旁证，不用于排名。'
      : `  → ${Math.abs(ctrl - best) < 0.05 ? '两者同量级 ⇒ 该指标对本任务**区分力很弱**，不要据此排名。' : '两者有差距，但仍需结合人工盲评看。'}`);
  }
  console.log(`\n报告：bench/report/${reportName}`);
}
