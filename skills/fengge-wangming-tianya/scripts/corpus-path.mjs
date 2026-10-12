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
