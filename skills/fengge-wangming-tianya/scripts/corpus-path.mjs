#!/usr/bin/env node
/**
 * corpus-path — 语料定位与溯源（可移植）。
 *
 * 为什么要有它：v1.3.2 之前 `fengge-ratio.mjs` / `fengge-align.mjs` / `fengge-profile.mjs`
 * 的默认语料路径写死成 `C:/Users/ASUS/Documents/dsh Project/dsh-chact/fg_fengge_v2_raw.json`，
 * 于是 `npm run ratio|align|accept` **只在作者那台机器上能跑** —— 换台机器或 CI 直接崩，
 * 这也是 align / accept 至今没敢进 CI 的真因（不是"不想加"，是加了必红）。
 *
 * 解析顺序（先命中先用）：
 *   1) --corpus / --fb / --bl <path>        显式参数
 *   2) FG_CORPUS / FG_BILI_CORPUS           环境变量
 *   3) $DSH_FENGGE_DATA/<name>              数据目录
 *   4) <repo>/data/corpus/<name>            随仓库分发的精简语料（若有）
 *   5) <repo>/../<name>                     作者工作区布局（仓库与语料同级）
 *   6) <cwd>/<name>                         就地跑
 * 一处都没有 → 抛错并列出**试过的每一个路径**，不静默降级、不返回 null。
 *
 * 溯源不写绝对路径：只记 name / sha256 / bytes。把作者本机路径写进随仓库分发的
 * data/*.json 既泄漏环境又不可复现——同样的输入必须得到同样的产物。
 *
 * 用法：
 *   node corpus-path.mjs --name fg_fengge_v2_raw.json          # 打印解析结果
 *   node corpus-path.mjs --fb --bl                             # 两路都试
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** 语料清单：name = 文件名，flag = 该语料的专用 CLI 参数，env = 专用环境变量，shape = 顶层 JSON 形状 */
export const CORPORA = {
  weibo: { name: 'fg_fengge_v2_raw.json', flag: '--fb', env: 'FG_CORPUS', label: '微博全量', shape: 'array' },
  bilibili: { name: 'fg_bili_corpus.json', flag: '--bl', env: 'FG_BILI_CORPUS', label: 'B站切片字幕', shape: 'object' },
  hotcomments: { name: 'fg_full_hotcomments.json', flag: '--hc', env: 'FG_HOTCOMMENTS', label: '高赞热评', shape: 'array' },
};

/** 顶层形状校验：拿错文件时早报错，好过在几百行之后崩在 `for...of` */
function assertShape(data, info, shape) {
  if (shape === 'array' && !Array.isArray(data)) {
    throw new Error(`语料 ${info.path} 顶层应为数组，实际是 ${typeof data}——文件名对吗？（该语料规格 shape=array）`);
  }
  if (shape === 'object' && (data === null || Array.isArray(data) || typeof data !== 'object')) {
    throw new Error(`语料 ${info.path} 顶层应为对象（BV 为键），实际是 ${Array.isArray(data) ? 'array' : typeof data}——文件名对吗？（该语料规格 shape=object）`);
  }
  return data;
}

export class CorpusNotFound extends Error {
  constructor(name, tried) {
    super(
      `找不到语料 ${name}。试过：\n  ${tried.join('\n  ')}\n` +
        `修法（任选其一）：\n` +
        `  · 显式指定：--corpus <path>\n` +
        `  · 环境变量：FG_CORPUS=<path>（B站用 FG_BILI_CORPUS）\n` +
        `  · 放到位：把 ${name} 放到 ${path.join(REPO_ROOT, '..')}\\ 或 ${path.join(REPO_ROOT, 'data', 'corpus')}\\`
    );
    this.name = 'CorpusNotFound';
    this.corpusName = name;
    this.tried = tried;
  }
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 解析语料路径。返回 { path, name, source, sha256, bytes }。
 * @param {object} opts
 * @param {string} opts.name        文件名
 * @param {string} [opts.cli]       显式路径（命令行）
 * @param {string} [opts.envValue]  显式路径（环境变量）
 * @param {string[]} [opts.searchDirs] 额外的候选目录（排在最前）
 * @param {string} [opts.cwd]
 */export function resolveCorpus({ name, cli, envValue, searchDirs = [], cwd = process.cwd() }) {
  const tried = [];
  const candidates = [];
  const push = (p, source) => { if (p) candidates.push({ p: path.resolve(p), source }); };

  push(cli, 'cli');
  push(envValue, 'env');
  push(process.env.DSH_FENGGE_DATA ? path.join(process.env.DSH_FENGGE_DATA, name) : null, 'env:DSH_FENGGE_DATA');
  for (const d of searchDirs) push(path.join(d, name), 'search');
  push(path.join(REPO_ROOT, 'data', 'corpus', name), 'repo');
  push(path.join(REPO_ROOT, '..', name), 'sibling');
  push(path.join(cwd, name), 'cwd');

  for (const c of candidates) {
    tried.push(`[${c.source}] ${c.p}`);
    if (!fs.existsSync(c.p)) continue;
    const buf = fs.readFileSync(c.p);
    return { path: c.p, name, source: c.source, sha256: sha256(buf), bytes: buf.length, buf };
  }
  throw new CorpusNotFound(name, tried);
}

/** 读 JSON 语料并按声明的 shape 校验（拿错文件时早报错，好过在几百行之后崩在 `for...of`） */
export function loadCorpus(opts) {
  const info = resolveCorpus(opts);
  let data;
  try {
    data = JSON.parse(info.buf.toString('utf8'));
  } catch (e) {
    throw new Error(`语料 ${info.path} 不是合法 JSON：${e.message}`);
  }
  assertShape(data, info, opts.shape || 'array');
  return { ...info, data };
}

/** 便携溯源对象（进 data/*.json，替代旧的绝对路径字符串） */
export function provenance(info) {
  return { name: info.name, sha256: info.sha256, bytes: info.bytes, source: info.source };
}

/** 人读的一行溯源 */
export function provenanceLine(info) {
  return `${info.name} · sha256 ${info.sha256.slice(0, 12)}… · ${(info.bytes / 1024).toFixed(0)} KiB · 来源 ${info.source}`;
}

/** CLI 便捷入口：从 argv 里按 flag/env 解析某一路语料 */
export function corpusFromArgv(key, argv = process.argv.slice(2)) {
  const spec = CORPORA[key];
  if (!spec) throw new Error(`未知语料键：${key}（可选 ${Object.keys(CORPORA).join(' / ')}）`);
  const at = argv.indexOf(spec.flag);
  const idx = argv.indexOf('--corpus');
  const cli = at >= 0 ? argv[at + 1] : idx >= 0 ? argv[idx + 1] : undefined;
  return resolveCorpus({ name: spec.name, cli, envValue: process.env[spec.env] });
}

/** CLI 便捷入口：解析 + 读 + 按规格 shape 校验，一步到位（脚本里最常用这个） */
export function loadCorpusFromArgv(key, argv = process.argv.slice(2)) {
  const spec = CORPORA[key];
  if (!spec) throw new Error(`未知语料键：${key}（可选 ${Object.keys(CORPORA).join(' / ')}）`);
  const info = corpusFromArgv(key, argv);
  let data;
  try {
    data = JSON.parse(info.buf.toString('utf8'));
  } catch (e) {
    throw new Error(`语料 ${info.path} 不是合法 JSON：${e.message}`);
  }
  assertShape(data, info, spec.shape || 'array');
  return { ...info, data };
}

// ---------------------------------------------------------------------------
// 微博语料的**多源合并**（v1.6.1 起）
//
// 为什么需要：v1.6.0 把口径改成「2,091 条 / 20 个月 / 三期」，但语料其实拆在两个文件里——
//   主流  <repo>/../fg_fengge_v2_raw.json  1,921 条，2025-02-04 ~ 2026-08-30（一、二期）
//   增量  <repo>/data/posts.json            633 条，2026-06-04 ~ 2026-10-27
//                                           其中 9-29 之后 170 条 = 三期（与主流 id 不重叠）
// 而 ratio / profile / retrieve 只读第一个文件 ⇒ 产出的「统计基准」实际上还是两期的：
// **文档说三期、尺子量两期**。这不是文案问题，是判据问题——align 拿旧尺子量新语料，
// 结果会照样绿，但它绿的已经不是它声称的那件事。
//
// 顺带纠正一个数字：v1.6.0 的 2,091 = 1,921 + 170（只数了三期那 170 条）。按 id 全量去重后
// 实际是 **2,093**——增量里另有 2 条 2026-06-10 的帖子主流没收进去（正文与主流都不同，不是重复）。
// 所以 v1.6.1 起统一用 2,093，且以本模块算出来的合并结果为准，不再手抄加法。
//
// 两个必须做对的细节：
//   ① **按 id 去重**：增量与主流在 6–8 月重叠 461 条，直接拼接会把这段重复计一遍。
//   ② **字段名归一化**：增量用 `is_long` / `is_retweet`，主流用 `isLong` / `retweeted`。
//      不归一化的话，增量里的长文与转发会被下游的 `!x.isLong && !x.retweeted` 当成原创短帖，
//      等于往基准里掺噪声——而且是静默的。
//
// 增量语料按仓库边界 **不入库**（.gitignore），所以它不存在时必须能照常跑：
// 缺失就静默跳过（sources 里也就只有主流），CI 与他人机器行为与之前完全一致。
// ---------------------------------------------------------------------------

export const INCREMENT_SPEC = {
  name: 'posts.json',
  flag: '--corpus-increment',
  env: 'FG_CORPUS_INCREMENT',
  label: '增量语料（三期）',
};

/**
 * 日期归一化成 ISO-8601。
 * 实测踩过：增量语料的 `created_at` 是 `Wed Jun 10 16:00:02 +0800 2026`（Date.toString 风格），
 * 而主流是 `2026-08-30T05:38:00.000Z`。下游若用 `String(iso).slice(0,10)` 比字符串日期，
 * 前者会整体落空——分期画像里三期直接变成 0 条、其余全进"未落期"，而且**不报错**。
 */
export function normalizeIso(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v;          // 兼容秒级时间戳
    return new Date(ms).toISOString();
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;     // 已是 ISO 前缀，原样保留
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

/** 把两份语料归一化成主流那套字段名；未识别字段原样保留 */
export function normalizePost(x) {
  return {
    ...x,
    iso: normalizeIso(x.iso || x.created_at || ''),
    text_raw: x.text_raw ?? x.text ?? '',
    retweeted: x.retweeted ?? x.is_retweet ?? false,
    rtText: x.rtText ?? '',
    isLong: x.isLong ?? x.is_long ?? false,
  };
}

const postKey = (p) => (p.id != null && p.id !== '' ? `id:${p.id}` : `txt:${p.text_raw || p.text || ''}`);

/**
 * 按 id 去重合并（主流行优先，增量只补新的）。
 * @returns {{posts: any[], added: number, duplicates: number, main: number, increment: number}}
 */
export function mergePosts(mainArr, incArr = []) {
  const seen = new Set();
  const posts = [];
  let duplicates = 0;
  for (const raw of mainArr) {
    const p = normalizePost(raw);
    seen.add(postKey(p));
    posts.push(p);
  }
  let added = 0;
  for (const raw of incArr) {
    const p = normalizePost(raw);
    const k = postKey(p);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    posts.push(p);
    added++;
  }
  return { posts, added, duplicates, main: mainArr.length, increment: incArr.length };
}

/**
 * 解析增量语料。
 * 语义：**显式指定就必须存在**（给了路径还找不到 → 报错，不回退到默认那份，
 * 否则"我只跑主流"会被悄悄换成"跑了仓库里那份增量"，实测就这么吃过 634 条 vs 1 条的假结果）；
 * 未显式指定时，仓库内 data/posts.json 存在就用、不存在就返回 null（它不是必需品）。
 */
export function resolveIncrement(argv = process.argv.slice(2)) {
  const i = argv.indexOf(INCREMENT_SPEC.flag);
  const explicit = i >= 0 ? argv[i + 1] : (process.env[INCREMENT_SPEC.env] || null);
  const read = (p) => {
    const buf = fs.readFileSync(p);
    let data;
    try {
      data = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      throw new Error(`增量语料 ${p} 不是合法 JSON：${e.message}`);
    }
    if (!Array.isArray(data)) throw new Error(`增量语料 ${p} 顶层应为数组，实际是 ${typeof data}`);
    return { path: p, name: INCREMENT_SPEC.name, source: 'increment', sha256: sha256(buf), bytes: buf.length, data };
  };

  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) {
      throw new Error(
        `显式指定的增量语料不存在：${p}\n` +
        `修法：给对路径，或去掉 ${INCREMENT_SPEC.flag}（并加 --no-increment 表示只跑主流行）。\n` +
        `不会悄悄回退到仓库默认的 data/${INCREMENT_SPEC.name}——那会把"只跑主流"变成"跑了另一份语料"。`
      );
    }
    return read(p);
  }

  const def = path.join(REPO_ROOT, 'data', INCREMENT_SPEC.name);
  return fs.existsSync(def) ? read(def) : null;
}

/**
 * 读**完整**微博语料 = 主流行 +（可选）增量。
 * 下游一律走这个，别再用 loadCorpusFromArgv('weibo') 只读一半。
 * @param {object} [o]
 * @param {string[]} [o.argv]
 * @param {boolean} [o.includeIncrement] 省略时看 argv 有没有 `--no-increment`
 */
export function loadWeiboAll({ argv = process.argv.slice(2), includeIncrement } = {}) {
  const main = loadCorpusFromArgv('weibo', argv);
  const wantInc = includeIncrement === undefined ? !argv.includes('--no-increment') : includeIncrement;
  const inc = wantInc ? resolveIncrement(argv) : null;
  const merged = mergePosts(main.data, inc ? inc.data : []);
  return {
    data: merged.posts,
    main,
    increment: inc,
    sources: [provenance(main), ...(inc ? [provenance(inc)] : [])],
    stats: {
      total: merged.posts.length,
      main: merged.main,
      increment: merged.increment,
      added: merged.added,
      duplicates: merged.duplicates,
    },
  };
}

/** 人读的多源溯源行（合并后语料用这个） */
export function sourcesLine(corpus) {
  const s = corpus.stats;
  const parts = corpus.sources.map((x) => `${x.name} sha256 ${x.sha256.slice(0, 12)}…`);
  return `${s.total} 条 = 主流 ${s.main} + 增量新增 ${s.added}（重叠去重 ${s.duplicates}）｜ ${parts.join(' + ')}`;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const keys = argv.includes('--all') ? Object.keys(CORPORA)
    : Object.entries(CORPORA).filter(([, s]) => argv.includes(s.flag)).map(([k]) => k);
  if (!keys.length) {
    console.log('用法：--name <文件名> | --fb | --bl | --hc | --all');
    console.log(`仓库根：${REPO_ROOT}`);
    process.exit(2);
  }
  let bad = 0;
  const named = argv.indexOf('--name') >= 0 ? argv[argv.indexOf('--name') + 1] : null;
  for (const k of keys) {
    try {
      const info = named ? resolveCorpus({ name: named }) : corpusFromArgv(k, argv);
      console.log(`✓ ${k.padEnd(12)} ${provenanceLine(info)}\n  ${info.path}`);
    } catch (e) {
      bad++;
      console.log(`✗ ${k.padEnd(12)} ${e.message}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
