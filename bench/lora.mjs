#!/usr/bin/env node
/**
 * lora.mjs — 微调（c3-lora）**数据导出**。协议见 bench/LORA.md。
 *
 * 本脚本**不训练、不联网、不要 GPU**。它只做一件事：把仓库里能合法用于训练的那部分语料
 * 导成两种标准格式，让"微调"这一档从"嘴上说说的档位"变成"任何人拿得到数据、跑得起来的协议"。
 *
 * 为什么导出两套：
 *   corpus.txt  —— 纯风格语料（一行一帖，已去重、切 train/dev）。**这才是蒸馏文风的正路**：
 *                  学习一个人的写法，本质是继续预训练，不是教它做问答。
 *   sft.jsonl   —— 指令配对（"围绕「X」写一条微博" → 该帖）。题目取自该帖**自带的 #话题标签#**：
 *                  标签是他自己打的，用它当题目不算我替他编选题（编了就会把"像我"教成"像我以为的他"）。
 *                  只有带标签的那部分帖子能进这一套，覆盖率会写在导出报告里。
 *
 * 切分时间性：**用时间切分而不是随机切分**（按 iso 排序取后 10% 当 dev）。
 * 随机切分会让同一段时间的用词同时出现在两边，dev 分数虚高——这一档最终要拿 bench/metrics.mjs
 * 在**新题目**上评，训练侧也必须保持同一种时间观。
 *
 * 用法：
 *   node bench/lora.mjs export --out bench/lora/data [--dev-ratio 0.1] [--json]
 *
 * ⚠️ 边界（重要）：导出的 `corpus-train.txt` 等文件**等于把全量语料复制进本地目录**。
 * 仓库对外的边界声明是「语料为公开博文的研究性引用，未全量随仓库分发」，所以：
 *   · 默认输出目录 `bench/lora/data/` **已在 .gitignore 里**，不要把它提交上去；
 *   · 可提交的只有**不含正文**的 `bench/report/lora-export.json`（条数 + sha256 + 时间跨度，
 *     足以让别人核对你导的是哪份语料，又不复制语料本身）；
 *   · 导出时会打印本警告。别在 CI 里跑 export——CI 上不需要训练数据，而它会在工作区留下语料副本。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCorpusFromArgv, provenance } from '../skills/fengge-wangming-tianya/scripts/corpus-path.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const textOf = (x) => String(x.text_raw || x.text || '').trim();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 可训练语料：原创短帖、去掉转发/长文、去重、按时间排序 */
export function trainablePosts(arr, { minChars = 8, maxChars = 200 } = {}) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (x.retweeted || x.rtText || x.isLong) continue;
    const t = textOf(x);
    const n = [...t].length;
    if (n < minChars || n > maxChars) continue;
    if (seen.has(t)) continue;          // 语料里存在近似重复帖（"怀念那个曾经一天赚1000元…"×2），重复=白给的过拟合
    seen.add(t);
    out.push({ text: t, iso: x.iso || x.created_at || '', tags: (t.match(/#[^#\n]{2,}#/g) || []).map((s) => s.replace(/#/g, '')) });
  }
  return out.sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
}

/** 时间切分：后 devRatio 当 dev（同一时间段不该两边都出现） */
export function timeSplit(posts, devRatio = 0.1) {
  const cut = Math.max(1, Math.floor(posts.length * (1 - devRatio)));
  return { train: posts.slice(0, cut), dev: posts.slice(cut) };
}

export function buildExport(posts, devRatio = 0.1) {
  const { train, dev } = timeSplit(posts, devRatio);
  const sftOf = (rows) => rows.filter((p) => p.tags.length)
    .map((p) => JSON.stringify({
      messages: [
        { role: 'user', content: `围绕「${p.tags[0]}」写一条微博。` },
        { role: 'assistant', content: p.text },
      ],
      meta: { iso: p.iso, tag: p.tags[0] },
    }));
  return {
    train, dev,
    corpusTrain: train.map((p) => p.text),
    corpusDev: dev.map((p) => p.text),
    sftTrain: sftOf(train),
    sftDev: sftOf(dev),
    stats: {
      train: train.length, dev: dev.length,
      sftTrain: sftOf(train).length, sftDev: sftOf(dev).length,
      tagCoverage: posts.length ? +(posts.filter((p) => p.tags.length).length / posts.length).toFixed(4) : 0,
      timeRange: posts.length ? [posts[0].iso, posts[posts.length - 1].iso] : [],
    },
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const cmd = argv[0];
  if (cmd !== 'export') { console.error('用法：export --out bench/lora/data [--dev-ratio 0.1]'); process.exit(2); }

  const outDir = path.resolve(arg('--out', path.join(HERE, 'lora', 'data')));
  const devRatio = Number(arg('--dev-ratio', 0.1));
  const info = loadCorpusFromArgv('weibo', argv);
  const posts = trainablePosts(info.data);
  const ex = buildExport(posts, devRatio);

  fs.mkdirSync(outDir, { recursive: true });
  const w = (name, lines) => {
    const f = path.join(outDir, name);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    return { file: name, lines: lines.length, sha256: sha(lines.join('\n')), bytes: fs.statSync(f).size };
  };
  const files = [
    w('corpus-train.txt', ex.corpusTrain),
    w('corpus-dev.txt', ex.corpusDev),
    w('sft-train.jsonl', ex.sftTrain),
    w('sft-dev.jsonl', ex.sftDev),
  ];
  const report = {
    at: new Date().toISOString(),
    corpus: provenance(info),
    split: { strategy: 'time', devRatio, trainRange: [ex.train[0]?.iso, ex.train[ex.train.length - 1]?.iso], devRange: [ex.dev[0]?.iso, ex.dev[ex.dev.length - 1]?.iso] },
    stats: ex.stats,
    files,
    outputDir: path.relative(path.resolve(HERE, '..'), outDir),
    boundary: '导出目录含全量语料正文，已在 .gitignore 中；可提交的只有本报告（不含正文，只含条数与 sha256）。',
    notRun: {
      status: 'not-run',
      reason: '本机无 GPU、无训练资源；本脚本只导出数据，不训练。',
      protocol: 'bench/LORA.md',
      acceptance: '要证明 LoRA 这一档值得，必须在同一个 30 题集上（bench/prompts.jsonl）跑出比 c2-retrieval 更低的 lint 失败率与更低的风格 JSD，否则加训练成本不划算。',
    },
  };
  // 报告落在 bench/report/（可提交，不含语料正文）；语料本体留在 gitignored 的 outDir
  fs.mkdirSync(path.join(HERE, 'report'), { recursive: true });
  fs.writeFileSync(path.join(HERE, 'report', 'lora-export.json'), JSON.stringify(report, null, 2));

  if (argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log(`训练数据已导出 → ${outDir}`);
  console.log(`语料 ${provenance(info).name} sha256 ${provenance(info).sha256.slice(0, 12)}…`);
  console.log(`切分：时间切分（train 早 / dev 晚），devRatio ${devRatio}`);
  console.log(`  train ${ex.stats.train} 帖 ｜ dev ${ex.stats.dev} 帖 ｜ 时间跨度 ${ex.stats.timeRange[0]} → ${ex.stats.timeRange[1]}`);
  console.log(`  带 #话题标签# 的比例 ${(ex.stats.tagCoverage * 100).toFixed(1)}% ⇒ sft-train ${ex.stats.sftTrain} 条 / sft-dev ${ex.stats.sftDev} 条`);
  for (const f of files) console.log(`  ${f.file.padEnd(18)} ${String(f.lines).padStart(5)} 行 ｜ ${(f.bytes / 1024).toFixed(0)} KiB ｜ sha256 ${f.sha256.slice(0, 12)}…`);
  console.log(`\n⚠️ 这次导出的是**全量语料正文**，只该留在本机：`);
  console.log(`   · ${path.relative(path.resolve(HERE, '..'), outDir)}/ 已在 .gitignore，别提交、别打进产物；`);
  console.log(`   · 可提交的核对面只有 bench/report/lora-export.json（条数 + sha256 + 时间跨度，不含正文）。`);
  console.log(`\n注意：本脚本不训练。协议（含验收标准）见 bench/LORA.md。`);
}
