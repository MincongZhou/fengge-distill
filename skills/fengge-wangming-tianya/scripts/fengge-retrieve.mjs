#!/usr/bin/env node
/**
 * fengge-retrieve — 语料检索（零依赖、零网络、纯本地）。
 *
 * 用途有两个，别混起来：
 *   ① 写作路径：动笔前先从语料里捞最像的几条当 few-shot 参照（"语料检索增强"）。
 *   ② 消融实验：作为 c2-retrieval 档的检索组件，回答"光有规则 vs 规则+真实语料"到底差多少。
 *
 * 为什么自己写而不是上 embedding：
 *   本包对 DSH STORE 承诺"零运行期依赖、不联网"，装向量库或调 embedding API 都会破坏这个契约。
 *   中文**句式**检索用字符 n-gram + BM25 就够——要的是"同一类句式"，不是语义相似。
 *
 * 为什么是 BM25 不是余弦：余弦没有文档长度归一化，会被超短帖劫持——
 *   实测查"我天天满仓上班…"时，3 字的「上班。」靠单一 bigram 冲到 0.207 排第一。
 *   BM25 的 k1/b 正是干这个的。
 *
 * 判据说明：分数是**风格相近度**，不是"这条适合当靶子"。选题器（lint 的选题器规则）管后者。
 *
 * 用法：
 *   node scripts/fengge-retrieve.mjs --query "公司要求下班后微信待命" --k 5
 *   node scripts/fengge-retrieve.mjs --query "..." --k 8 --json
 *   node scripts/fengge-retrieve.mjs --selftest
 * 语料靠 corpus-path.mjs 解析（--fb / FG_CORPUS / 仓库相邻目录）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWeiboAll, sourcesLine } from './corpus-path.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');

/** 默认只把 ≥8 字的原创短帖当检索素材：3–7 字的"上班。""太帅了"当 few-shot 参照教不了任何东西 */
export const MIN_EXAMPLE_LEN = 8;

/** 语料条目 → 可用于检索的纯文本；返回 null 表示这条不是"原创短帖"（转发/长文不算） */
export function eligibleText(x, { minLen = MIN_EXAMPLE_LEN } = {}) {
  if (x.retweeted || x.rtText || x.isLong) return null;
  const t = String(x.text_raw || x.text || '').trim();
  if (!t || [...t].length < minLen) return null;
  return t;
}

/**
 * 字符 n-gram + 拉丁词切分。
 * 中文只取 n=2..3（段长 1 时才留单字）——单字几乎都是停用词级噪声，
 * 实测保留单字会把"下班/上班"这种泛词抬到前面，把真正的句式匹配压下去。
 */
export function tokenize(text, { nMin = 2, nMax = 3 } = {}) {
  const t = String(text ?? '');
  const toks = [];
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{1,}/g)) toks.push(m[0].toLowerCase());
  for (const seg of t.match(/[\u4e00-\u9fff]+/g) || []) {
    if (seg.length < nMin) { toks.push(seg); continue; }
    for (let n = nMin; n <= Math.min(nMax, seg.length); n++) {
      for (let i = 0; i + n <= seg.length; i++) toks.push(seg.slice(i, i + n));
    }
  }
  return toks;
}

/** 建 BM25 索引 */
export function buildIndex(docs, opts = {}) {
  const { k1 = 1.2, b = 0.75 } = opts;
  const texts = docs.map((d) => (typeof d === 'string' ? d : d.text));
  const tokenized = texts.map((t) => tokenize(t, opts));
  const n = texts.length;

  const df = new Map();
  for (const toks of tokenized) for (const g of new Set(toks)) df.set(g, (df.get(g) || 0) + 1);
  const idf = new Map();
  for (const [g, d] of df) idf.set(g, Math.log(1 + (n - d + 0.5) / (d + 0.5)));

  const tfs = tokenized.map((toks) => {
    const m = new Map();
    for (const g of toks) m.set(g, (m.get(g) || 0) + 1);
    return m;
  });
  const lens = tokenized.map((t) => t.length);
  const avgdl = lens.reduce((a, c) => a + c, 0) / (n || 1) || 1;

  return { docs, texts, df, idf, tfs, lens, avgdl, n, k1, b };
}

/** 检索 top-k。查询词去重（BM25 的 tf 是文档侧的，查询侧重复无意义） */
export function retrieve(index, query, k = 5) {
  const qTerms = [...new Set(tokenize(query))];
  const { k1, b, avgdl } = index;
  const out = [];
  for (let i = 0; i < index.n; i++) {
    const tf = index.tfs[i];
    const dl = index.lens[i];
    let s = 0;
    for (const t of qTerms) {
      const f = tf.get(t);
      if (!f) continue;
      const w = index.idf.get(t) ?? 0;
      s += w * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl));
    }
    if (s > 0) out.push({ i, score: s });
  }
  out.sort((a, b2) => b2.score - a.score || a.i - b2.i);
  return out.slice(0, k).map(({ i, score }) => ({
    score: +score.toFixed(4),
    text: index.texts[i],
    iso: (index.docs[i] && (index.docs[i].iso || index.docs[i].created_at)) || '',
    reads: (index.docs[i] && (index.docs[i].reads ?? null)),
  }));
}

/** 从语料数组建索引（过滤出原创短帖，并按 minLen 丢掉教不了东西的极短帖） */
export function indexFromCorpus(arr, opts = {}) {
  const docs = [];
  for (const x of arr) {
    const text = eligibleText(x, opts);
    if (text) docs.push({ ...x, text });
  }
  return { ...buildIndex(docs, opts), skipped: arr.length - docs.length };
}

/** 便捷入口：一次性拿"查询 → top-k 真实语料"，供生成器与消融复用 */
export function makeRetriever(arr, opts = {}) {
  const index = indexFromCorpus(arr, opts);
  return { index, search: (q, k = 8) => retrieve(index, q, k) };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

  if (argv.includes('--selftest')) {
    const docs = [
      '沪指失守3900，我994一克买的黄金反倒红了，这波我不慌，仓位拿一路',
      '今天收工吃碗面，32，没约女粉，跟家人们报备',
      '公司发的中秋福利是一句祝福，我算了算这句祝福值0块',
      '上班。',
      '我天天上班，公司还要求下班后微信待命，这不就是把人当牲口使唤吗', // 这条才是查询的真正相关项
    ];
    const idx = buildIndex(docs);
    const self = retrieve(idx, '今天收工吃碗面，32，没约女粉', 1);
    const ok1 = self.length === 1 && self[0].text.startsWith('今天收工吃碗面');

    // 短帖偏置回归：夹具里存在真正相关的长帖时，3 字的「上班。」不得压过它。
    // （余弦在这一项上会失败：超短帖的向量被单个 bigram 占满，余弦反而更高。）
    const bias = retrieve(idx, '我天天上班，公司还要求下班后微信待命，这合理吗', 5);
    const longRank = bias.findIndex((r) => r.text.startsWith('我天天上班'));
    const shortRank = bias.findIndex((r) => r.text === '上班。');
    const ok2 = longRank === 0 && (shortRank === -1 || shortRank > longRank);

    console.log(`${ok1 ? '✓' : '✗'} 自反性：查询自身排第一（score=${self[0]?.score}）`);
    console.log(`${ok2 ? '✓' : '✗'} 短帖偏置回归：相关长帖第 ${longRank + 1} 名 / 3 字「上班。」第 ${shortRank === -1 ? '未入榜' : shortRank + 1} 名（须长帖在前）`);
    process.exit(ok1 && ok2 ? 0 : 1);
  }

  const query = arg('--query', null);
  if (!query) { console.error('用法：--query "文案" [--k 5] [--json] | --selftest'); process.exit(2); }
  const k = Number(arg('--k', 5));
  const minLen = Number(arg('--min-len', MIN_EXAMPLE_LEN));
  // 走合并语料：三期（2026-09-29 起）170 条也在里面。只读主流行会把"他当下怎么写"漏掉，
  // 而检索取 few-shot 的意义恰恰是参照当下语域。
  const corpus = loadWeiboAll({ argv });
  const t0 = Date.now();
  const idx = indexFromCorpus(corpus.data, { minLen });
  const hits = retrieve(idx, query, k);
  const ms = Date.now() - t0;

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ query, k, minLen, corpus: sourcesLine(corpus), sources: corpus.sources, stats: corpus.stats, eligible: idx.n, skipped: idx.skipped, hits }, null, 2));
  } else {
    console.log(`检索：${query}`);
    console.log(`语料 ${corpus.data.length} 条 → 可检索素材 ${idx.n} 条（跳过转发/长文/短于 ${minLen} 字共 ${idx.skipped} 条） ｜ 建索引 ${ms}ms`);
    console.log(`${sourcesLine(corpus)}\n`);
    for (const [i, h] of hits.entries()) console.log(`${String(i + 1).padStart(2)}. ${h.score.toFixed(3)}  ${h.text.slice(0, 60)}${h.text.length > 60 ? '…' : ''}`);
    if (!hits.length) console.log('（没有共享 n-gram 的语料条目——换个说法再试，或确认 FG_CORPUS 指对了文件）');
  }
}
