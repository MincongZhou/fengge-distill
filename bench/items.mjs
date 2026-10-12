#!/usr/bin/env node
/**
 * items.mjs — 组装 100 条评测集（bench/items.jsonl）。
 *
 * 组成（每一类都有明确出处，不掺"我编的"）：
 *   human-short    30  语料里的真实原创短帖 —— 正例锚点（这是他本人发的微博短帖）
 *   human-bili     12  真实 B站直播字幕片段 —— **同一个人、另一套语域**（口语，写微博立刻露馅）
 *   human-long      8  真实长微博（isLong） —— 同一个人、另一种形态
 *   model-formal   15  模型生成的正式书面腔（neg-formal 档） —— 硬负例
 *   model-base     15  基模直出（c0-base 档）
 *   model-pipeline 20  蒸馏规则 + 语料检索增强（c2-retrieval 档）—— 本项目实际推荐的管线
 *   ─────────────────
 *   合计          100
 *
 * 弱标签（weak）只写在**出处本身就能判定**的地方，判不了的一律 null，不硬凑：
 *   human-short     像=1 / 串子味=1（他就是靠这个吃饭的）
 *   model-formal    像=0 / 串子味=0（正式书面腔，与峰哥体相反）
 *   human-bili      null（是同一个人，只是语域不对——算"不像"会把两个人混淆）
 *   human-long      null（本人长文，形态不同，同理）
 *   model-base / model-pipeline  null（**这正是要人工判的**，机器不给答案）
 *
 * 抽样可复现：用固定种子的线性同余抽样，不用 Math.random；换人重跑拿到同一批。
 * 人工标注见 bench/labels.mjs（盲评表 + 胜率 + Cohen κ）。
 *
 * 用法：
 *   node bench/items.mjs --run <runId>          # 需要已有生成结果
 *   node bench/items.mjs --run <runId> --seed 20261012
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpusFromArgv, provenance, provenanceLine } from '../skills/fengge-wangming-tianya/scripts/corpus-path.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ITEMS_FILE = path.join(HERE, 'items.jsonl');

export const COMPOSITION = {
  'human-short': 30,
  'human-bili': 12,
  'human-long': 8,
  'model-formal': 15,
  'model-base': 15,
  'model-pipeline': 20,
};

/**
 * 固定种子线性同余抽样：保证任何人在任何机器上重跑都拿到同一批。
 *
 * 必须取**高位**再缩放，不能用 `x % n`：LCG 的低位周期极短（乘数 mod 4 == 1 ⇒ 末两位周期 4），
 * 实测 `x % 30` 会退化到只覆盖 16 个值，于是"抽 20 条"静默只给出 16 条。
 */
export function makeSampler(seed = 20261012) {
  let x = seed >>> 0;
  return (n) => {
    x = (x * 1103515245 + 12345) >>> 0;
    return Math.floor((x / 4294967296) * n);
  };
}

/** 不重复抽 k 个索引。抽不满就抛错——静默少给会让"100 条评测集"变成"96 条"而无人察觉。 */
export function sampleIndices(poolSize, k, rand) {
  const want = Math.min(k, poolSize);
  const seen = new Set();
  let guard = 0;
  const cap = Math.max(1000, poolSize * 100);
  while (seen.size < want && guard++ < cap) seen.add(rand(poolSize));
  if (seen.size < want) {
    throw new Error(`抽样退化：池子 ${poolSize} 条、要抽 ${want} 条，只抽到 ${seen.size} 条（试了 ${guard} 次）。检查随机源是否均匀。`);
  }
  return [...seen];
}

const textOf = (x) => String(x.text_raw || x.text || '').trim();

/** 直播字幕 → 短句片段（B站语料是 BV 为键的对象，sub 可能是字符串或数组） */
export function biliFragments(blRaw, { minLen = 12, maxLen = 70 } = {}) {
  const out = [];
  for (const [bv, v] of Object.entries(blRaw)) {
    const joined = typeof v.sub === 'string' ? v.sub
      : Array.isArray(v.sub) ? v.sub.map((x) => (typeof x === 'string' ? x : x.text || x.content || '')).join('') : '';
    if (!joined) continue;
    for (const s of joined.split(/[。！？!?，、；;\n]/)) {
      const t = s.trim();
      const n = [...t].length;
      if (n >= minLen && n <= maxLen) out.push({ text: t, bv, chars: n });
    }
  }
  // 去重（同一份字幕资产会被复用，见 bilibili.md 的三条口径坑）
  const seen = new Set();
  return out.filter((f) => {
    const k = f.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function buildItems({ corpusInfo, biliInfo, runDir, seed = 20261012 }) {
  const rand = makeSampler(seed);
  const posts = corpusInfo.data;
  const prov = (info) => ({ kind: 'corpus', file: info.name, sha256: info.sha256 });

  const shortPool = posts.filter((x) => !x.retweeted && !x.rtText && !x.isLong && [...textOf(x)].length >= 15);
  const longPool = posts.filter((x) => x.isLong && textOf(x));
  const biliPool = biliFragments(biliInfo.data);

  const readRun = (cond) => {
    const dir = path.join(runDir, cond);
    if (!fs.existsSync(dir)) {
      throw new Error(`运行目录里没有 ${cond}：${dir}\n先跑 node bench/generate.mjs --conditions ${cond}`);
    }
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  };

  const items = [];
  let seq = 0;
  const push = (cls, text, extra) => {
    items.push({
      id: `i${String(++seq).padStart(3, '0')}`,
      class: cls,
      text,
      chars: [...text].length,
      weak: { like_fengge: null, chuanzi: null, confidence: 'none' },
      human: { like_fengge: null, chuanzi: null },
      ...extra,
    });
  };

  for (const i of sampleIndices(shortPool.length, COMPOSITION['human-short'], rand)) {
    const x = shortPool[i];
    push('human-short', textOf(x), {
      provenance: { ...prov(corpusInfo), iso: x.iso || x.created_at || '', reads: x.reads ?? null },
      weak: { like_fengge: 1, chuanzi: 1, confidence: 'high' },
    });
  }
  for (const i of sampleIndices(longPool.length, COMPOSITION['human-long'], rand)) {
    const x = longPool[i];
    push('human-long', textOf(x), { provenance: { ...prov(corpusInfo), iso: x.iso || x.created_at || '', form: 'long' } });
  }
  for (const i of sampleIndices(biliPool.length, COMPOSITION['human-bili'], rand)) {
    const f = biliPool[i];
    push('human-bili', f.text, { provenance: { ...prov(biliInfo), bv: f.bv, register: 'live' } });
  }

  const formal = readRun('neg-formal');
  for (const i of sampleIndices(formal.length, COMPOSITION['model-formal'], rand)) {
    const r = formal[i];
    push('model-formal', r.text, {
      provenance: { kind: 'generated', condition: 'neg-formal', model: r.model, at: r.at, promptSha256: r.promptSha256 },
      topic: r.topic, topicId: r.id,
      weak: { like_fengge: 0, chuanzi: 0, confidence: 'high' },
    });
  }
  const base = readRun('c0-base');
  for (const i of sampleIndices(base.length, COMPOSITION['model-base'], rand)) {
    const r = base[i];
    push('model-base', r.text, {
      provenance: { kind: 'generated', condition: 'c0-base', model: r.model, at: r.at, promptSha256: r.promptSha256 },
      topic: r.topic, topicId: r.id,
    });
  }
  const pipe = readRun('c2-retrieval');
  for (const i of sampleIndices(pipe.length, COMPOSITION['model-pipeline'], rand)) {
    const r = pipe[i];
    push('model-pipeline', r.text, {
      provenance: { kind: 'generated', condition: 'c2-retrieval', model: r.model, at: r.at, promptSha256: r.promptSha256 },
      topic: r.topic, topicId: r.id,
    });
  }

  // 打乱顺序（避免"前 30 条都是真的"这种位置暗示），但保留 id → 可回查
  for (let i = items.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const runId = arg('--run');
  if (!runId) { console.error('用法：--run <runId> [--seed 20261012]'); process.exit(2); }
  const runDir = path.join(HERE, 'runs', runId);
  if (!fs.existsSync(runDir)) { console.error(`没有这次运行：${runDir}`); process.exit(2); }

  const seed = Number(arg('--seed', 20261012));
  const corpusInfo = loadCorpusFromArgv('weibo', argv);
  const biliInfo = loadCorpusFromArgv('bilibili', argv);

  const items = buildItems({ corpusInfo, biliInfo, runDir, seed });
  fs.mkdirSync(path.join(HERE, 'report'), { recursive: true });
  fs.writeFileSync(ITEMS_FILE, items.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(HERE, 'report', 'items-summary.json'), JSON.stringify({
    at: new Date().toISOString(), runId, seed,
    corpus: provenance(corpusInfo), bilibili: provenance(biliInfo),
    total: items.length,
    byClass: Object.fromEntries(Object.entries(COMPOSITION).map(([k]) => [k, items.filter((i) => i.class === k).length])),
    lengths: Object.fromEntries(Object.entries(COMPOSITION).map(([k]) => {
      const xs = items.filter((i) => i.class === k).map((i) => i.chars).sort((a, b) => a - b);
      return [k, { min: xs[0], p50: xs[Math.floor(xs.length / 2)], max: xs[xs.length - 1] }];
    })),
  }, null, 2));

  console.log(`评测集：${items.length} 条 → bench/items.jsonl`);
  console.log(`种子 ${seed} ｜ 语料 ${provenanceLine(corpusInfo)}`);
  for (const [k, n] of Object.entries(COMPOSITION)) {
    const xs = items.filter((i) => i.class === k);
    const lens = xs.map((i) => i.chars).sort((a, b) => a - b);
    console.log(`  ${k.padEnd(15)} ${String(xs.length).padStart(3)} 条 ｜ 字数 ${lens[0]}–${lens[lens.length - 1]}（中位 ${lens[Math.floor(lens.length / 2)]}）`);
  }
  const weakHigh = items.filter((i) => i.weak.confidence === 'high').length;
  console.log(`\n弱标签可判定（出处本身即结论）：${weakHigh} 条 ｜ 待人工判：${items.length - weakHigh} 条`);
  console.log('下一步：node bench/labels.mjs sheet --run ' + runId);
}
