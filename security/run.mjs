#!/usr/bin/env node
/**
 * run.mjs — 对抗探针真跑器（**联网，调真实模型**，会产生费用）。
 *
 * 它回答的问题只有一个：**我们的管线（c2-retrieval）在攻击面上比基模（c0-base）好还是差。**
 * 所以两档必须同题、同参数、同检测器，唯一变量是 system 里有没有 SKILL.md + 真实语料——
 * 这正是 bench/generate.mjs 消融的口径，别自己另发明一套，否则两张表没法对读。
 *
 * 三个已踩过的坑，写死在这里：
 *   1) **必须 thinking:{type:'disabled'}**：deepseek-flash 是推理模型，实测 176 个输出 token 有 167 个
 *      是 reasoning_tokens，不关思考会出现"跑完了但正文是空的"（bench 那边 c1 档 3/9 条空输出）。
 *   2) **maxTokens 给足 4000**：max_tokens 是上限不产生费用，给少了答案还没开始就被截断。
 *   3) **别在并发里读 key 或打印它**：key 只经 resolveApiKey 进内存，manifest 里只留脱敏来源。
 *
 * 产物落 security/report/run-<时间戳>/：
 *   <condition>/<probeId>.json  每条：探针、条件、原始输出、usage（含缓存命中）、检测结果
 *   manifest.json               参数与语料的指纹（可复现）
 *   summary.json                类别 × 条件的攻击成功率（FAIL 条数/总条数）+ 每条 FAIL 的原文摘要
 *
 * 用法：
 *   node security/run.mjs --dry-run                                  # 只看拼好的 prompt，不花钱
 *   node security/run.mjs --conditions c2-retrieval,c0-base --concurrency 3
 *   node security/run.mjs --conditions c2-retrieval --only s01,s02   # 单测某几条
 *   node security/run.mjs --resume run-2026-10-12T06-00-00           # 续跑，已有的条目跳过
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveApiKey, chat, DEFAULT_BASE_URL, DEFAULT_MODEL } from '../bench/lib/deepseek.mjs';
import { buildMessages } from '../bench/generate.mjs';
import { loadCorpusFromArgv, provenance } from '../skills/fengge-wangming-tianya/scripts/corpus-path.mjs';
import { indexFromCorpus, retrieve } from '../skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs';
import { detect, failed, DEFAULT_PEOPLE } from './detect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SKILL = path.join(REPO, 'skills', 'fengge-wangming-tianya');
const PROBES = path.join(HERE, 'probes.jsonl');
const REPORT = path.join(HERE, 'report');

/** 只跑这两档：c2 是我们的管线，c0 是基模对照。
 *  c1/neg 不跑——安全面上"有没有真实语料"是关键变量，c1 介于两者之间，
 *  加进来只会让表格变宽而不改变结论（要用也可以：buildMessages 支持，--conditions 直接写）。 */
export const DEFAULT_CONDITIONS = ['c2-retrieval', 'c0-base'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const utf8stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** 读探针集：一行一个 JSON，字段 id/class/topic/expect（见 probes.jsonl 文件头说明）。 */
export function loadProbes(file = PROBES) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l, i) => {
      let j;
      try { j = JSON.parse(l); } catch (e) { throw new Error(`probes.jsonl 第 ${i + 1} 行不是合法 JSON：${e.message}`); }
      for (const k of ['id', 'class', 'topic', 'expect']) if (!j[k]) throw new Error(`probes.jsonl 第 ${i + 1} 行缺字段 ${k}`);
      return j;
    });
}

/** 极简并发池：与 bench/generate.mjs 同款，行为一致才好对照 */
async function pool(items, limit, worker, onDone) {
  const queue = items.slice();
  let active = 0, finished = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < limit && queue.length) {
        const item = queue.shift();
        active++;
        worker(item)
          .then(() => { finished++; onDone?.(finished, items.length, item); })
          .catch(reject)
          .finally(() => { active--; next(); });
      }
    };
    next();
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

  const conditions = (arg('--conditions') || DEFAULT_CONDITIONS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const probes = loadProbes(arg('--probes', PROBES));
  const only = arg('--only');
  const selected = only ? probes.filter((p) => only.split(',').map((s) => s.trim()).includes(p.id)) : probes;
  if (!selected.length) { console.error('没有选中任何探针（--only s01,s02）'); process.exit(2); }

  const model = arg('--model', DEFAULT_MODEL);
  const temperature = Number(arg('--temperature', 1.0));
  const maxTokens = Number(arg('--max-tokens', 4000));
  const thinking = { type: 'disabled' };        // 见文件头坑 1：这一条不许改
  const concurrency = Number(arg('--concurrency', 3));
  const topK = Number(arg('--top-k', 8));
  const dry = argv.includes('--dry-run');

  const skillText = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');

  // c2 才需要语料；只跑 c0 时不该因为找不到语料就跑不起来。
  let retriever = null;
  if (conditions.includes('c2-retrieval')) {
    const info = loadCorpusFromArgv('weibo', argv);
    retriever = { info, ...indexFromCorpus(info.data) };
  }
  // 检索 query 用题目原文：探针题干就是模拟"用户会怎么问"，用题干检索才反映真实分布；
  // 用探针的 id 或类别检索会人为把语料引向灾情/八卦，把对照做脏。
  const examplesFor = (p) => (retriever ? retrieve(retriever, p.topic, topK) : []);
  const msgsFor = (c, p) => buildMessages(c, { id: p.id, axis: p.class, topic: p.topic }, { skillText, examples: examplesFor(p) });

  if (dry) {
    const byClass = {};
    for (const p of selected) byClass[p.class] = (byClass[p.class] || 0) + 1;
    console.log(`探针 ${selected.length} 条：${Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    for (const p of selected) {
      console.log(`\n${'='.repeat(72)}\n[${p.id}] ${p.class}｜期望：${p.expect}`);
      console.log(`题目：${p.topic}`);
      for (const c of conditions) {
        const msgs = msgsFor(c, p);
        const chars = msgs.map((m) => [...m.content].length);
        console.log(`  [${c}] system ${chars[0]} 字 / user ${chars[1]} 字 —— user 全文：${msgs[1].content.replace(/\n/g, ' ⏎ ')}`);
        if (c === 'c2-retrieval') {
          const ex = examplesFor(p);
          console.log(`         检索到 ${ex.length} 条真实语料（top ${topK}）：${ex.map((e) => e.score.toFixed(2)).join(' / ')}`);
        }
      }
    }
    console.log(`\n（--dry-run：未调用模型，未产生任何费用）`);
    process.exit(0);
  }

  const { key, source } = resolveApiKey({ keyFile: arg('--key-file') });
  const runId = arg('--resume') || `run-${utf8stamp()}`;
  const dirOf = (c) => path.join(REPORT, runId, c);
  const fileOf = (c, id) => path.join(dirOf(c), `${id}.json`);

  const manifestPath = path.join(REPORT, runId, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {
    runId, startedAt: new Date().toISOString(), model, temperature, maxTokens, thinking, concurrency, topK,
    // 脱敏：只留最后一段文件名，绝不写完整路径、更不写 key 本身
    keySource: String(source).replace(/^.*[\\/]/, '…/'),
    conditions, probeCount: selected.length,
    probeFile: path.relative(REPO, arg('--probes', PROBES)).replace(/\\/g, '/'),
    probeHash: sha(JSON.stringify(probes)),
    skillHash: sha(skillText),
    corpus: retriever ? provenance(retriever.info) : null,
    note: 'thinking=disabled / maxTokens=4000 / temperature=1.0；c3-lora 未参与（本次没跑，见 bench/LORA.md）',
  };
  fs.mkdirSync(path.join(REPORT, runId), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`runId: ${runId}`);
  console.log(`模型 ${model} ｜ temperature ${temperature} ｜ max_tokens ${maxTokens} ｜ thinking ${JSON.stringify(thinking)} ｜ 并发 ${concurrency}`);
  console.log(`条件 ${conditions.join(' / ')} ｜ 探针 ${selected.length} 条 ｜ 合计 ${conditions.length * selected.length} 次调用`);
  console.log(`key 来源：${manifest.keySource}（内容未打印、未落盘）`);
  if (retriever) console.log(`语料：${retriever.info.name} · 可检索 ${retriever.n} 条 · 来源 ${retriever.info.source}\n`);
  else console.log('');

  const jobs = [];
  for (const c of conditions) for (const p of selected) jobs.push({ c, p });

  const records = [];
  await pool(jobs, concurrency, async ({ c, p }) => {
    // 已有结果且**调用成功**才跳过：失败记录要能被重跑覆盖，否则一次超时会永久留在报告里。
    if (fs.existsSync(fileOf(c, p.id))) {
      try {
        const prior = JSON.parse(fs.readFileSync(fileOf(c, p.id), 'utf8'));
        if (prior.text) { records.push(prior); return; }
      } catch { /* 坏文件当没跑过 */ }
    }
    const msgs = msgsFor(c, p);
    const ex = examplesFor(p);
    const rec = {
      probeId: p.id, probeClass: p.class, topic: p.topic, expect: p.expect, condition: c,
      at: new Date().toISOString(), model,
      promptSha256: sha(JSON.stringify(msgs)),
      promptChars: [...msgs[0].content].length + [...msgs[1].content].length,
      retrieved: c === 'c2-retrieval' ? ex.map((e) => ({ score: e.score, text: e.text })) : undefined,
    };
    try {
      const r = await chat({ key, model, temperature, maxTokens, thinking, messages: msgs, baseUrl: arg('--base-url', DEFAULT_BASE_URL) });
      const det = detect(r.text, { probe: p, systemPrompt: msgs[0].content, people: DEFAULT_PEOPLE });
      Object.assign(rec, {
        text: r.text, finishReason: r.finishReason, usage: r.usage, ms: r.ms, attempts: r.attempts,
        flags: det.flags, fail: failed(det).length,
        verdict: failed(det).length ? 'ATTACK_SUCCEEDED' : 'DEFENDED',
      });
    } catch (e) {
      // 调用失败 ≠ 攻击成功。如实记成 error 并**排除在成功率分母之外**，
      // 否则网络抖一下就会把某一档的成功率抬上去（那是测量事故，不是结论）。
      Object.assign(rec, { error: String(e && e.message || e), text: '', flags: [], fail: 0, verdict: 'ERROR' });
    }
    fs.mkdirSync(dirOf(c), { recursive: true });   // 目录先建：否则调用完才发现写不进去，白花钱
    fs.writeFileSync(fileOf(c, p.id), JSON.stringify(rec, null, 2));
    records.push(rec);
  }, (done, total, item) => {
    const rec = [...records].reverse().find((x) => x.condition === item.c && x.probeId === item.p.id);
    const tag = rec?.verdict === 'ATTACK_SUCCEEDED' ? 'FAIL' : rec?.verdict === 'ERROR' ? 'ERR ' : 'ok  ';
    console.log(`  [${String(done).padStart(3)}/${total}] ${tag} ${item.c} ${item.p.id}`);
  });

  // ── 汇总：扫目录而不是用内存里的 records，保证"报告里的数字 = 落盘的文件"──
  const all = [];
  for (const c of conditions) {
    const d = dirOf(c);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
      all.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
    }
  }

  const classes = [...new Set(probes.map((p) => p.class))];
  const rate = (cond, klass) => {
    // 分母只算**有效调用**（排除 ERROR）——错的不该算进守住也不该算进被攻破
    const rows = all.filter((r) => r.condition === cond && (klass === '*' || r.probeClass === klass) && !r.error);
    const failRows = rows.filter((r) => r.fail > 0);
    return { n: rows.length, fail: failRows.length, rate: rows.length ? +(failRows.length / rows.length).toFixed(4) : null };
  };

  const summary = {
    runId, at: new Date().toISOString(), model, temperature, maxTokens, thinking, topK, conditions,
    probes: { total: probes.length, ran: selected.length, byClass: Object.fromEntries(classes.map((k) => [k, probes.filter((p) => p.class === k).length])) },
    // 攻击成功率 = FAIL 条数 / 该格有效条数；按 类别 × 条件 交叉
    attackSuccess: {
      byClassAndCondition: Object.fromEntries(classes.map((k) => [k, Object.fromEntries(conditions.map((c) => [c, rate(c, k)]))])),
      overall: Object.fromEntries(conditions.map((c) => [c, rate(c, '*')])),
      byRule: (() => {   // 哪条规则最常被抓到：说清"是模型越线"还是"检测器敏感"
        const m = {};
        for (const r of all) for (const f of (r.flags || [])) if (f.level === 'FAIL') m[f.rule] = (m[f.rule] || 0) + 1;
        return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
      })(),
    },
    errors: all.filter((r) => r.error).map((r) => ({ condition: r.condition, probeId: r.probeId, error: r.error.slice(0, 200) })),
    truncated: all.filter((r) => r.finishReason === 'length').map((r) => ({ condition: r.condition, probeId: r.probeId })),
    // 成本要能事后核：这四项原样留档（prompt_cache_hit_tokens 直接决定单位成本）
    tokens: {
      prompt: all.reduce((a, r) => a + (r.usage?.prompt_tokens ?? 0), 0),
      promptCached: all.reduce((a, r) => a + (r.usage?.prompt_cache_hit_tokens ?? 0), 0),
      completion: all.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0),
      reasoning: all.reduce((a, r) => a + (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0),
    },
    avgMs: Math.round(all.reduce((a, r) => a + (r.ms ?? 0), 0) / (all.length || 1)),
    // 分档输出长度：c2 与 c0 的正文长度差一个量级（SKILL.md 把它压短），
    // 不记这一项就没法判断"成功率差异"是不是"输出长度差异"的副产物。
    perCondition: Object.fromEntries(conditions.map((c) => {
      const rows = all.filter((r) => r.condition === c);
      const chars = rows.reduce((a, r) => a + [...(r.text || '')].length, 0);
      return [c, {
        n: rows.length,
        avgChars: +(chars / (rows.length || 1)).toFixed(1),
        maxChars: rows.reduce((a, r) => Math.max(a, [...(r.text || '')].length), 0),
        usage: {
          prompt: rows.reduce((a, r) => a + (r.usage?.prompt_tokens ?? 0), 0),
          promptCached: rows.reduce((a, r) => a + (r.usage?.prompt_cache_hit_tokens ?? 0), 0),
          completion: rows.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0),
        },
      }];
    })),
    fails: all.filter((r) => r.fail > 0).map((r) => ({
      condition: r.condition, probeId: r.probeId, probeClass: r.probeClass,
      rules: r.flags.filter((f) => f.level === 'FAIL').map((f) => f.rule),
      evidence: r.flags.filter((f) => f.level === 'FAIL').map((f) => f.evidence).filter(Boolean),
      text: r.text,
    })),
    warns: all.filter((r) => (r.flags || []).some((f) => f.level === 'WARN')).map((r) => ({
      condition: r.condition, probeId: r.probeId,
      rules: r.flags.filter((f) => f.level === 'WARN').map((f) => f.rule),
    })),
    perRecord: all.map((r) => ({
      condition: r.condition, probeId: r.probeId, probeClass: r.probeClass, verdict: r.verdict,
      chars: [...(r.text || '')].length, finishReason: r.finishReason, ms: r.ms, usage: r.usage,
    })),
  };
  fs.writeFileSync(path.join(REPORT, runId, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n完成 ${all.length} 条 → security/report/${runId}/`);
  console.log(`攻击成功率（FAIL/有效条数）：`);
  for (const c of conditions) {
    const o = summary.attackSuccess.overall[c];
    console.log(`  ${c.padEnd(14)} 合计 ${o.fail}/${o.n}${o.rate === null ? '' : ` = ${(o.rate * 100).toFixed(1)}%`}`);
    for (const k of classes) {
      const s = summary.attackSuccess.byClassAndCondition[k][c];
      console.log(`      ${k.padEnd(17)} ${s.fail}/${s.n}${s.rate === null ? '' : ` = ${(s.rate * 100).toFixed(1)}%`}`);
    }
  }
  if (summary.errors.length) console.log(`⚠ 调用失败 ${summary.errors.length} 条（已排除在成功率之外）：${summary.errors.map((e) => `${e.condition}/${e.probeId}`).join(' ')}`);
  if (summary.truncated.length) console.log(`⚠ 被 max_tokens 截断 ${summary.truncated.length} 条：${summary.truncated.map((e) => `${e.condition}/${e.probeId}`).join(' ')}`);
  console.log(`token：prompt ${summary.tokens.prompt}（命中缓存 ${summary.tokens.promptCached}）／ completion ${summary.tokens.completion}（其中 reasoning ${summary.tokens.reasoning}）｜ 平均 ${summary.avgMs}ms/条`);
}
