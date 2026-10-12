#!/usr/bin/env node
/**
 * export-conditions.mjs — 把「四档条件的最终 messages」原样导出成 JSON，给本地基座复用。
 *
 * 为什么要有它：本轮要在**同一个开源基座**上重跑 c0/c1/c2，才谈得上和 c3-lora 比。
 * 而"可比"的前提是**提示词逐字相同**——不是"我照着写一遍很像"。所以这里不重写任何模板，
 * 直接调 bench/generate.mjs 导出的 buildMessages()，把结果数组 dump 出来；
 * Python 侧一句条件逻辑都没有，只管把 messages 喂给 tokenizer 的 chat template。
 *
 * 输出含 SKILL.md 与真实语料片段 ⇒ 写到 bench/lora/data/（已在 .gitignore），不要提交。
 *
 * 用法：node bench/lora/export-conditions.mjs --out bench/lora/data/conditions.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONDITIONS, loadPrompts, buildMessages, RUN_DEFAULTS } from '../generate.mjs';
import { loadCorpusFromArgv } from '../../skills/fengge-wangming-tianya/scripts/corpus-path.mjs';
import { indexFromCorpus, retrieve } from '../../skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SKILL = path.join(REPO, 'skills', 'fengge-wangming-tianya');

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const outFile = path.resolve(arg('--out', path.join(HERE, 'data', 'conditions.json')));

const prompts = loadPrompts();
const skillText = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
const info = loadCorpusFromArgv('weibo', argv);
const idx = indexFromCorpus(info.data);

// 本地要跑的四档。
// c3-lora 用 **c0-base 的 messages**：微调这一档的意义就是"把风格训进权重，不用再灌规则"，
// 所以它必须拿**最朴素的那条提示**去比——否则赢了也说不清是训练起的作用还是提示起的作用。
// （另一条路"LoRA + SKILL.md 规则"本轮没跑，属已知未覆盖项。）
const toRun = ['c0-base', 'c1-distilled', 'c2-retrieval'];
const messages = {};
const retrieved = {};
for (const c of toRun) {
  messages[c] = {};
  for (const p of prompts) {
    const examples = retrieve(idx, p.topic, RUN_DEFAULTS.topK);
    messages[c][p.id] = buildMessages(c, p, { skillText, examples });
    if (c === 'c2-retrieval') retrieved[p.id] = examples.map((e) => ({ score: e.score, iso: e.iso, sha256: undefined, chars: [...e.text].length, text: e.text }));
  }
}
// 显式复制一份给 c3-lora，而不是在 Python 里做隐式别名：条件归属必须写在数据里，读的人一眼能看见。
messages['c3-lora'] = messages['c0-base'];

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({
  at: new Date().toISOString(),
  why: '四档条件的最终 messages，逐字来自 bench/generate.mjs 的 buildMessages()，供本地基座复用以保证与 API 版可比',
  prompts,
  conditions: [...toRun, 'c3-lora'],
  labels: { ...Object.fromEntries(toRun.map((c) => [c, CONDITIONS[c].label])), 'c3-lora': '微调 LoRA（用 c0-base 的朴素提示：微调的意义就是不用再灌规则）' },
  decode: { temperature: RUN_DEFAULTS.temperature, maxTokens: RUN_DEFAULTS.maxTokens, thinking: RUN_DEFAULTS.thinking },
  messages,
  retrieval: retrieved,
  corpus: { name: info.name, sha256: info.sha256, bytes: info.bytes },
}, null, 2), 'utf8');

let chars = 0;
for (const c of toRun) for (const p of prompts) chars += messages[c][p.id].reduce((a, m) => a + m.content.length, 0);
console.log(`已导出 ${toRun.length} 档 + c3-lora（复用 c0-base 的 messages） × ${prompts.length} 题 → ${path.relative(REPO, outFile)}`);
console.log(`prompt 总字符 ${chars} ｜ 含 SKILL.md ${skillText.length} 字与真实语料片段 ⇒ 此文件不进版本库`);
for (const c of toRun) {
  const sizes = prompts.map((p) => messages[c][p.id].reduce((a, m) => a + m.content.length, 0));
  console.log(`  ${c.padEnd(14)} prompt 字符 ${Math.min(...sizes)}–${Math.max(...sizes)}（中位 ${sizes.sort((a, b) => a - b)[14]}）`);
}
