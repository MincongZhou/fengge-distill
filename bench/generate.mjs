#!/usr/bin/env node
/**
 * generate.mjs — 消融与评测集的**生成器**（包外，联网，要 key）。
 *
 * 四档条件，30 条固定选题，逐条配对（同一题在四档下各生成一次，才谈得上可比）：
 *   c0-base       基模直出：不给任何峰哥语料/规则，就当"一个普通中文社媒写作助手"
 *   c1-distilled  蒸馏规则：system 里灌入打包进 skill 的 SKILL.md 全文（真实产物，不是我另写的摘要）
 *   c2-retrieval  蒸馏规则 + 语料检索增强：再附 top-k 真实语料（fengge-retrieve.mjs 的 BM25 检索）
 *   neg-formal    正式书面腔（评测集的负例来源，不是峰哥体）
 *
 * c3-lora（微调）**没有实现生成**——本机无 GPU、无训练资源，见 bench/README.md 的 LoRA 协议。
 * 消融表里它按"未运行"如实标注，不给数字。
 *
 * 产物冻结在 bench/runs/<runId>/，含每条的真实 usage（token）、耗时、重试次数、prompt 指纹，
 * 所以"成本"和"可复现"都能事后核，不靠复述。
 *
 * 用法：
 *   node bench/generate.mjs --dry-run --only p01                 # 只看拼出来的 prompt，不花钱
 *   node bench/generate.mjs --conditions c0-base,c1-distilled
 *   node bench/generate.mjs --concurrency 3                      # 默认四档全跑
 *   node bench/generate.mjs --resume <runId>                     # 续跑（已有结果的条目跳过）
 *   node bench/generate.mjs --redact <runId>                     # 发布前脱敏（见下）
 *
 * 关于脱敏：c2 档的记录里会带"检索到了哪 8 条真实语料"，默认写的是**原文**——
 * 那等于把语料又复制一份进仓库，而仓库的边界声明是"语料未全量随仓库分发"。
 * 检索是确定性的（同一份语料 + 同一个题目 → 同样的 top-8），所以发布时用 --redact
 * 把原文换成 sha256：既保住了可核验性（对得上就是同一条），又不分发语料。
 * 指标与消融表都不读这里的原文（metrics.mjs 自己按语料重算），所以脱敏不影响任何数字。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveApiKey, chat, DEFAULT_BASE_URL, DEFAULT_MODEL } from './lib/deepseek.mjs';
import { loadCorpusFromArgv, provenance } from '../skills/fengge-wangming-tianya/scripts/corpus-path.mjs';
import { indexFromCorpus, retrieve } from '../skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SKILL = path.join(REPO, 'skills', 'fengge-wangming-tianya');
const PROMPTS = path.join(HERE, 'prompts.jsonl');
const RUNS = path.join(HERE, 'runs');

/** 四档共用的输出格式约束（公平性关键：不给它，模型会把 SKILL.md 当规程来"汇报过程"，
 *  产出 "**微博正文：** > ... — 用到的东西：…" 这种混着流程说明的文本，比的就不再是规则而是排版卫生。
 *  原始返回仍然逐条留档，任何人可以不用这层约束重新打分。 */
const ONLY_POST = '\n只输出微博正文本身：不要标题、不要解释、不要用引号包裹、不要标注你用了哪条规则、不要分点。';

export const CONDITIONS = {
  'c0-base': {
    label: '基模直出（无规则无语料）',
    system: '你是一个中文社交媒体写作助手，帮博主写微博。',
    user: (p) => `请就下面的题目写一条中文微博，一条就好。${ONLY_POST}\n题目：${p.topic}`,
  },
  'c1-distilled': {
    label: '蒸馏规则（SKILL.md 全文）',
    system: null, // 运行时填入 SKILL.md
    user: (p) => `按上面的规矩，就下面的题目写一条微博，一条就好。${ONLY_POST}\n题目：${p.topic}`,
  },
  'c2-retrieval': {
    label: '蒸馏规则 + 语料检索增强（top-8 真实语料）',
    system: null, // 运行时填入 SKILL.md + few-shot
    user: (p) => `按上面的规矩，参考上面这些真实语料的口吻，就下面的题目写一条微博，一条就好。${ONLY_POST}\n题目：${p.topic}`,
  },
  'neg-formal': {
    label: '正式书面腔（负例来源）',
    system: '你是一位严谨的中文评论撰稿人，写正式、书面、结构清晰的评论文本。',
    user: (p) => `就下面的现象写一段正式的评论，要用书面语，可以分点论述，200 字左右。\n现象：${p.topic}`,
  },
};

export const RUN_DEFAULTS = {
  model: DEFAULT_MODEL,
  temperature: 1.0,
  maxTokens: 4000,                 // max_tokens 只是上限、不产生费用；给足以免再次被推理/长文截断
  thinking: { type: 'disabled' },  // 四档统一关思考（否则 flash 的 reasoning 会吃光预算产出空文本）
  topK: 8,
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 读 30 条固定选题 */
export function loadPrompts(file = PROMPTS) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * 组装某一档的 messages。
 * @param {string} condition
 * @param {object} prompt        {id, axis, topic}
 * @param {object} ctx           { skillText, examples: [{text, score}] }
 */
export function buildMessages(condition, prompt, ctx = {}) {
  const c = CONDITIONS[condition];
  if (!c) throw new Error(`未知条件：${condition}（可选 ${Object.keys(CONDITIONS).join(' / ')}）`);

  let system = c.system;
  if (condition === 'c1-distilled') system = ctx.skillText;
  if (condition === 'c2-retrieval') {
    const ex = (ctx.examples || []).map((e, i) => `${i + 1}. ${e.text}`).join('\n');
    system = `${ctx.skillText}\n\n---\n\n以下是同一位博主真实发过的微博，作为口吻参照（**不要照抄内容，只学口吻和句式**）：\n${ex}`;
  }
  if (!system) throw new Error(`${condition} 的 system 为空——c1/c2 需要 skillText`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: c.user(prompt) },
  ];
}

const utf8stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dirOf = (runId, condition) => path.join(RUNS, runId, condition);
const fileOf = (runId, condition, id) => path.join(dirOf(runId, condition), `${id}.json`);

/** 已有结果且内容非空 → 视为已完成（--resume 用） */
function already(runId, condition, id) {
  const f = fileOf(runId, condition, id);
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return typeof j.text === 'string' && j.text.trim() ? j : null;
  } catch { return null; }
}

/** 极简并发池：保持输入顺序不重要，按完成顺序数数即可 */
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

  const conditions = (arg('--conditions') || Object.keys(CONDITIONS).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of conditions) if (!CONDITIONS[c]) { console.error(`未知条件 ${c}`); process.exit(2); }

  // 发布前脱敏：把已冻结记录里 retrieved[].text 换成 sha256（不改任何数字，也不重跑模型）
  if (argv.includes('--redact')) {
    const runId = arg('--redact');
    const dir = path.join(RUNS, runId);
    if (!fs.existsSync(dir)) { console.error(`没有这次运行：${dir}`); process.exit(2); }
    let files = 0, entries = 0;
    for (const cond of fs.readdirSync(dir)) {
      const cd = path.join(dir, cond);
      if (!fs.statSync(cd).isDirectory()) continue;
      for (const f of fs.readdirSync(cd).filter((f) => f.endsWith('.json'))) {
        const p = path.join(cd, f);
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Array.isArray(j.retrieved)) continue;
        let touched = false;
        j.retrieved = j.retrieved.map((r) => {
          if (typeof r.text !== 'string') return r;
          touched = true; entries++;
          const { text, ...rest } = r;
          return { ...rest, sha256: sha(text), chars: [...text].length };
        });
        if (touched) { fs.writeFileSync(p, JSON.stringify(j, null, 2)); files++; }
      }
    }
    console.log(`脱敏完成：${files} 个记录文件里的 ${entries} 条检索原文已替换为 sha256（bench/runs/${runId}）`);
    console.log('可核验性未丢：检索是确定性的，对得上 sha256 就是同一条语料；指标与消融表都不读这里的原文。');
    process.exit(0);
  }

  const prompts = loadPrompts(arg('--prompts', PROMPTS));
  const only = arg('--only');
  const selected = only ? prompts.filter((p) => only.split(',').map((s) => s.trim()).includes(p.id)) : prompts;
  if (!selected.length) { console.error('没有选中任何选题（--only p01,p02）'); process.exit(2); }

  const model = arg('--model', RUN_DEFAULTS.model);
  const temperature = Number(arg('--temperature', RUN_DEFAULTS.temperature));
  const maxTokens = Number(arg('--max-tokens', RUN_DEFAULTS.maxTokens));
  const concurrency = Number(arg('--concurrency', 3));
  const dry = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const thinking = argv.includes('--no-think-off') ? null : RUN_DEFAULTS.thinking;

  const skillText = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');

  // 检索增强需要语料；只有 c2/neg 用到，但 dry-run 与无 c2 时不强制有语料。
  let retriever = null;
  const needCorpus = conditions.includes('c2-retrieval');
  if (needCorpus) {
    const info = loadCorpusFromArgv('weibo', argv);
    retriever = { info, ...indexFromCorpus(info.data) };
  }

  const examplesFor = (p) => (retriever ? retrieve(retriever, p.topic, RUN_DEFAULTS.topK) : []);

  if (dry) {
    for (const p of selected) {
      for (const c of conditions) {
        const msgs = buildMessages(c, p, { skillText, examples: examplesFor(p) });
        const chars = msgs.map((m) => m.content.length);
        console.log(`\n${'='.repeat(70)}\n[${c}] ${p.id} ${p.axis}｜题目：${p.topic}`);
        console.log(`prompt 长度：system ${chars[0]} 字 / user ${chars[1]} 字 = 合计 ${chars[0] + chars[1]} 字`);
        if (c === 'c2-retrieval') {
          console.log(`检索到的真实语料（top ${RUN_DEFAULTS.topK}）：`);
          for (const e of examplesFor(p)) console.log(`   ${e.score.toFixed(3)}  ${e.text.slice(0, 50)}`);
        }
        console.log(`--- user ---\n${msgs[1].content}`);
      }
    }
    console.log(`\n（--dry-run：未调用模型，未产生任何费用）`);
    process.exit(0);
  }

  const { key, source } = resolveApiKey({ keyFile: arg('--key-file') });
  const runId = arg('--resume') || `run-${utf8stamp()}`;
  fs.mkdirSync(path.join(RUNS, runId), { recursive: true });

  const c2meta = retriever ? { corpus: provenance(retriever.info), eligible: retriever.n, topK: RUN_DEFAULTS.topK } : null;
  const manifestPath = path.join(RUNS, runId, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {
        runId, startedAt: new Date().toISOString(),
        model, baseUrl: arg('--base-url', DEFAULT_BASE_URL), temperature, maxTokens, thinking, concurrency,
        keySource: source.replace(/^.*\//, '…/'),
        conditions,
        conditionHash: sha(JSON.stringify(Object.fromEntries(conditions.map((c) => [c, { system: CONDITIONS[c].system, user: String(CONDITIONS[c].user) }])))),
        promptFile: path.relative(REPO, arg('--prompts', PROMPTS)),
        promptHash: sha(JSON.stringify(prompts)),
        prompts: prompts.length,
        retrieval: c2meta,
        note: 'c3-lora 未运行（无 GPU／训练资源），见 bench/README.md',
      };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`runId: ${runId}`);
  console.log(`模型 ${model} ｜ temperature ${temperature} ｜ max_tokens ${maxTokens} ｜ 并发 ${concurrency}`);
  console.log(`条件 ${conditions.join(' / ')} ｜ 选题 ${selected.length} 条 ｜ 合计 ${conditions.length * selected.length} 次生成`);
  console.log(`key 来源：${source}\n`);

  const jobs = [];
  for (const c of conditions) for (const p of selected) jobs.push({ c, p });

  const results = [];
  await pool(jobs, concurrency, async ({ c, p }) => {
    const prior = !force && already(runId, c, p.id);
    if (prior) { results.push({ c, id: p.id, text: prior.text, cached: true }); return; }
    const examples = examplesFor(p);
    const msgs = buildMessages(c, p, { skillText, examples });
    const r = await chat({ key, model, temperature, maxTokens, thinking, messages: msgs, baseUrl: arg('--base-url', DEFAULT_BASE_URL) });
    const rec = {
      id: p.id, axis: p.axis, topic: p.topic, condition: c,
      text: r.text, finishReason: r.finishReason, model: r.model,
      usage: r.usage, ms: r.ms, attempts: r.attempts, at: new Date().toISOString(),
      maxTokens, temperature, thinking,
      promptSha256: sha(JSON.stringify(msgs)),
      promptChars: msgs[0].content.length + msgs[1].content.length,
      retrieved: c === 'c2-retrieval'
        ? examples.map((e) => ({ score: e.score, iso: e.iso, sha256: sha(e.text), chars: [...e.text].length }))
        : undefined,
    };
    fs.mkdirSync(dirOf(runId, c), { recursive: true });   // 条件子目录要先建（否则调用完才发现写不进去，白花钱）
    fs.writeFileSync(fileOf(runId, c, p.id), JSON.stringify(rec, null, 2));
    results.push({ c, id: p.id, text: r.text, usage: r.usage });
  }, (done, total, item) => {
    const rec = [...results].reverse().find((x) => x.c === item.c && x.id === item.p.id);
    const tok = rec?.usage ? ` ${rec.usage.completion_tokens ?? '?'}out` : '';
    console.log(`  [${String(done).padStart(3)}/${total}] ${item.c} ${item.p.id}${tok}`);
  });

  // 落一张汇总，免得每次都要扫目录
  const all = [];
  let tokIn = 0, tokCache = 0, tokOut = 0, ms = 0, trunc = 0;
  for (const c of conditions) {
    for (const f of fs.readdirSync(dirOf(runId, c)).filter((f) => f.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(dirOf(runId, c), f), 'utf8'));
      all.push({ condition: c, id: j.id, axis: j.axis, chars: [...(j.text || '')].length, finishReason: j.finishReason, usage: j.usage, ms: j.ms });
      tokIn += j.usage?.prompt_tokens ?? 0;
      tokCache += j.usage?.prompt_cache_hit_tokens ?? 0;
      tokOut += j.usage?.completion_tokens ?? 0;
      ms += j.ms ?? 0;
      if (j.finishReason === 'length') trunc++;
    }
  }
  const summary = {
    runId, at: new Date().toISOString(), model, temperature, conditions, n: all.length,
    tokens: { prompt: tokIn, promptCached: tokCache, completion: tokOut, total: tokIn + tokOut },
    avgMs: Math.round(ms / (all.length || 1)), truncated: trunc, perCondition: {},
  };
  for (const c of conditions) {
    const rows = all.filter((r) => r.condition === c);
    summary.perCondition[c] = {
      n: rows.length,
      avgChars: +(rows.reduce((a, r) => a + r.chars, 0) / (rows.length || 1)).toFixed(1),
      promptTokens: rows.reduce((a, r) => a + (r.usage?.prompt_tokens ?? 0), 0),
      completionTokens: rows.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0),
      reasoningTokens: rows.reduce((a, r) => a + (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0),
      truncated: rows.filter((r) => r.finishReason === 'length').length,
    };
  }
  fs.writeFileSync(path.join(RUNS, runId, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n完成 ${all.length} 条 → bench/runs/${runId}/`);
  console.log(`token：prompt ${tokIn}（命中缓存 ${tokCache}）／ completion ${tokOut}｜ 平均 ${summary.avgMs}ms/条｜ 被截断 ${trunc} 条`);
  for (const c of conditions) {
    const s = summary.perCondition[c];
    console.log(`  ${c.padEnd(14)} 平均 ${String(s.avgChars).padStart(5)} 字 ｜ prompt ${String(s.promptTokens).padStart(7)} tok ｜ out ${String(s.completionTokens).padStart(6)} tok（其中 reasoning ${s.reasoningTokens}）｜ 截断 ${s.truncated}`);
  }
}
