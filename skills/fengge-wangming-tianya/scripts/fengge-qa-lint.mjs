#!/usr/bin/env node
/**
 * fengge-qa-lint — 文字场问答（打字场）的「像不像」机械判定。
 *
 * 为什么单独一份、不塞进 fengge-lint：
 *   fengge-lint 判的是**发博**（长度按 14–68 字短帖、要求落点绕回自己、免责句看位置）。
 *   而问答体的口径几乎是**反的**——33 条真实回复里中位 9 字、最长 28、**「我」出现 0 次**。
 *   拿发博的尺子量短答，每一句都会被判"太短、没有落点"，等于把真话判成假话。
 *   所以问答体必须有自己的尺子；两把尺子共用的只有"换行/分点/直播语域/假口头禅"这几条硬格式。
 *
 * 判据出处（全部来自 references/qa-mode.md 的实测，改阈值前请先改那份文档）：
 *   短答 n=33 ｜ 中位 9 字 ｜ p25=6 / p75=12 ｜ 最长 28 ｜ ≤10 字占 64%（21/33）
 *   长答 n=12 ｜ 中位 128 字 ｜ >100 字 7 条
 *   短答里「我」0 次、「峰哥」0 次 ⇒ "绕回自己"是发博的落点，聊天里没有
 *   长答里「我」必须是主语（他答投资问题最后一定拐回自己）
 *
 * 用法：
 *   node scripts/fengge-qa-lint.mjs --text "先发一百条，有人看再说。" --mode short
 *   node scripts/fengge-qa-lint.mjs --file batch.txt --mode long --json
 *   node scripts/fengge-qa-lint.mjs --selftest          # 正反例自检（含**真实回复**正例）
 *   node scripts/fengge-qa-lint.mjs --file x.txt --ignore 短答主语
 * 退出码：0 = 无 FAIL；1 = 有 FAIL
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 两套形态的硬参数（qa-mode.md 第一节） */
export const QA_LEN = {
  short: { floor: 2, comfortMax: 18, hardMax: 28, note: '33 条回复：中位 9 字 / p75 12 / 最长 28；≤10 字占 64%' },
  long: { floor: 80, comfortMin: 100, comfortMax: 160, hardMax: 200, note: '12 条转述长答：中位 128 字，>100 字 7 条' },
};

const DISCLAIMER = /个人观点|个人看法|个人判断|个人猜测|不构成[^。！？]{0,8}建议|风险自担/;
const JUDGEMENT = /点位|价位|预测|剑指|看到\d|突破\d|回不到\d|赛道|板块|概念|大概率|能不能涨|还能不能/;
const LIVE_REGISTER = /对吧|对不对|我跟你说/;
// 客服/助手腔：这些一出现就不是"他"，是"AI 在服务你"
const SERVICE = /感谢(你的|您)?提问|感谢支持|希望对(你|您)有(所)?帮助|希望能帮到(你|您)|欢迎随时|还需要(什么|其他)|还有什么(可以|能)帮|请问还有|不客气|很高兴为(你|您)解答/;
// 教程/建议：他的锐评与问答都不给方案（1914 条里「建议大家」0 条）
const ADVICE = /建议(你|您|大家)|可以试试|不妨|第一步|应该(去|要)(先|做)|希望对|首先[，,].{0,40}其次/;
// 带单/荐股/承诺收益：账号安全线，任何形态都禁
const STOCK_CALL = /跟我买|跟着我买|带你(买|炒|上车)|包赚|保底|稳赚|私信我|加我微信|上车(吧|就)/;
const IMPERSONATE = /我是峰哥本人|我本人就是峰哥|我就是峰哥本人/;
const LIST_MARK = /^\s*(?:[-*•]|\d+[.、)]|[（(]\d+[）)])\s*/m;

function add(out, level, rule, msg, evidence = '') { out.push({ level, rule, msg, evidence }); }

/**
 * 判一条文字场回答。
 * @param {string} text
 * @param {'short'|'long'} mode
 */
export function checkQA(text, mode = 'short') {
  const t = String(text ?? '').trim();
  const body = t.replace(/[\u200b\ufeff]/g, '');
  const len = [...body].length;
  const out = [];
  const L = QA_LEN[mode];
  if (!L) throw new Error(`未知模式 ${mode}（short | long）`);

  // ---- 长度（按形态分卡；短答刻意**不设下限**，因为 12% 的真回复就是个短词）----
  if (len < L.floor) add(out, 'FAIL', '长度', `${len} 字 < 下限 ${L.floor}`, L.note);
  else if (len > L.hardMax) add(out, 'FAIL', '长度', `${len} 字 > 语料最长 ${L.hardMax}`, L.note);
  else if (mode === 'short' && len > L.comfortMax) add(out, 'WARN', '长度·偏长', `${len} 字 > ${L.comfortMax}（p75 是 12）`, '短答就该一句挡回；超过 18 字要能说出为什么');
  else if (mode === 'long' && len < L.comfortMin) add(out, 'WARN', '长度·偏短', `${len} 字 < ${L.comfortMin}`, '长答是"帖内认真正面答"的形态，中位 128 字');
  else add(out, 'PASS', '长度', `${len} 字（${mode}）`, '');

  // ---- 主语：这是问答体与发博体最大的一处相反 ----
  const wo = (body.match(/我/g) || []).length;
  if (mode === 'short') {
    if (wo > 0) add(out, 'FAIL', '短答主语', `出现 ${wo} 个「我」`, '33 条真实回复里「我」0 次——聊天里他不落回自己；"绕回我"是发博的落点');
    else add(out, 'PASS', '短答主语', '无「我」', '');
    if (/峰哥/.test(body)) add(out, 'FAIL', '短答自称', '出现「峰哥」', '33 条里「峰哥」0 次；聊天里不自称第三人称');
    else add(out, 'PASS', '短答自称', '无「峰哥」', '');
  } else {
    if (wo === 0) add(out, 'FAIL', '长答主语', '没有「我」', '长答里"我"必须是主语——他答问题最后一定拐回自己的仓位/直播/运气');
    else add(out, 'PASS', '长答主语', `${wo} 个「我」`, '');
  }

  // ---- 硬格式（与发博共用）----
  const nl = (body.match(/\n/g) || []).length;
  if (nl > 0) add(out, 'FAIL', '换行', `出现 ${nl} 处换行`, '他 1914 条里 0 条换行；问答也一样，一条一口气');
  if (LIST_MARK.test(body)) add(out, 'FAIL', '分点', '出现列表/编号', '不列 1.2.3.、不给操作步骤');
  if (/\d+[.、]\s*\S+\s*[\d]*[.、]/.test(body)) add(out, 'FAIL', '分点', '出现编号列表', '长答也不分点');

  // ---- 语域：文字场不能带直播专属标记 ----
  const live = body.match(new RegExp(LIVE_REGISTER.source, 'g'));
  if (live) add(out, 'FAIL', '直播语域', `命中 ${[...new Set(live)].join(' / ')}`, '对吧/对不对/我跟你说 是口播专属；文字场出现即露馅（每万字差 11–59 倍）');
  else add(out, 'PASS', '直播语域', '无', '');

  // ---- 客服腔 / 教程腔 ----
  const svc = body.match(SERVICE);
  if (svc) add(out, 'FAIL', '客服腔', `命中「${svc[0]}」`, '他不是助手；"感谢提问/希望对你有帮助"一概不出现');
  else add(out, 'PASS', '客服腔', '无', '');
  const adv = body.match(ADVICE);
  if (adv) add(out, 'FAIL', '给建议', `命中「${adv[0]}」`, '1914 条里「建议大家」0 条；问答也不给方案');
  else add(out, 'PASS', '给建议', '无', '');

  // ---- 账号安全线 ----
  const call = body.match(STOCK_CALL);
  if (call) add(out, 'FAIL', '荐股/带单', `命中「${call[0]}」`, '不荐股、不承诺收益、不带单；讲仓位只说"我"');
  const imp = body.match(IMPERSONATE);
  if (imp) add(out, 'FAIL', '冒充本人', `命中「${imp[0]}」`, '只模仿句式，不自称本人');

  // ---- 表情（与发博同一实测）----
  const br = body.match(/\[[^\]\s]{1,6}\]/g);
  if (br) add(out, 'FAIL', '方括号表情', `命中 ${br.join(' ')}`, '1914 条里方括号表情 0 条');
  const emo = body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
  if (emo.length > 0) add(out, 'WARN', '图形 emoji', `${emo.length} 个`, '只有 3.7% 的帖子带，且基本 1 个；问答里更少见');

  // ---- 句数：短答"不补第二句" ----
  if (mode === 'short') {
    const sentences = body.split(/[。！？]/).filter((s) => s.trim()).length;
    if (sentences > 2) add(out, 'WARN', '短答句数', `${sentences} 句`, '一句话一个落点，不解释、不补第二句');
  }

  // ---- 长答三段结构（转述 → 归类反问 → 因果落回自己）----
  if (mode === 'long') {
    const relay = /(问我|有人问|有粉丝问|有网友问|有B友问|有网友说|粉丝问|网友问|我问|投稿)/.test(body) || /[「"“][^」"”]{4,}[」"”]/.test(body);
    if (!relay) add(out, 'FAIL', '长答·转述', '没有"替对方把话说完"的转述', '长答第一段是带引号原话转述（"有B友问我：…"）');
    else add(out, 'PASS', '长答·转述', '有转述', '');
    const counter = /[？?]/.test(body) && /(为什么|怎么就|凭什么|难道|怎么会)/.test(body);
    // 只给 WARN：语料自己的 dry-run 长答里也有一条没有反问句，硬拦会误伤真实答案
    if (!counter) add(out, 'WARN', '长答·归类反问', '没有"把个人问题升级成一类人"的反问', '三段里第二段通常是"为什么会这样呢？"；没有也能成立，但要有别的归类动作');
    else add(out, 'PASS', '长答·归类反问', '有反问', '');
  }

  // ---- 免责句：默认不挂，只在写了具体判断/预测时才配 ----
  if (DISCLAIMER.test(body)) {
    if (!JUDGEMENT.test(body)) add(out, 'WARN', '免责句·挂载对象', '挂了免责但这条没有具体判断/预测', '他本人全量 0.5%，且只挂点位/价位/赛道断言；短答挂免责是最典型的 AI 味');
    else add(out, 'PASS', '免责句', '有判断 → 配免责（合规）', '');
  } else {
    add(out, 'PASS', '免责句', '未挂（默认应当如此）', '');
  }

  return { len, mode, results: out, fails: out.filter((r) => r.level === 'FAIL').length, warns: out.filter((r) => r.level === 'WARN').length };
}

/** 自检用的正反例。**正例里刻意放真实回复**——判据把真人判红，比漏判坏得多。 */
export const SELFTEST = [
  // --- 真实回复（qa-mode.md 引用的原话），必须过 ---
  { text: '面膜', mode: 'short', want: true, why: '真实回复：一个名词砸回去' },
  { text: '孤儿企业', mode: 'short', want: true, why: '真实回复：四字定性' },
  { text: '我是个移动的目标，不是个电线杆', mode: 'short', want: false, why: '真实回复但含「我」——正是要拦的那类"发博腔"（保留为反例，说明这是**已标注的例外**）' },
  { text: '别猜了，满仓的科技', mode: 'short', want: true, why: '真实回复：只自曝不推荐' },
  { text: '平平安安健健康康比啥都强', mode: 'short', want: true, why: '真实回复：俗话收尾' },
  { text: '先发一百条，有人看再说', mode: 'short', want: true, why: 'dry-run 短答：前置条件型' },
  // --- 生成物里的典型 AI 味，必须拦 ---
  { text: '感谢你的提问！建议你先评估一下自己的现金流，希望对你有帮助。', mode: 'short', want: false, why: '客服腔 + 给建议' },
  { text: '我觉得你可以先攒 6 个月的生活费，\n然后再考虑辞职。', mode: 'short', want: false, why: '换行 + 给建议' },
  { text: '第一步先做定位，第二步做内容，第三步做变现。', mode: 'short', want: false, why: '教程分步' },
  { text: '我觉得这个事儿，我跟你说，真不是那么回事。', mode: 'short', want: false, why: '有「我」+ 直播语域' },
  { text: '先发一百条，有人看再说。[加油]', mode: 'short', want: false, why: '方括号表情' },
  // --- 长答 ---
  {
    text: '有粉丝问我，35 岁月薪 8000，要不要辞职做自媒体。这问题我一个月能收到十几个。为什么要辞职呢？因为你觉得上班没盼头。可自媒体不是盼头，是没人给你兜底——我这种是赶上了，你辞了，房贷谁还？先当副业发一百条，有人看，再谈辞职。',
    mode: 'long', want: true, why: 'qa-mode.md 的 dry-run 长答（转述→反问→落回自己）',
  },
  {
    // 注意：这里必须用 qa-mode.md 的**原文**。我第一版把含「我」的那两句删掉当夹具，
    // 结果被判"没有我、太短"——错在夹具，不在判据。截断别人的示例来测判据，等于自己造一个反例。
    text: '有网友说被骂到抑郁。这事儿我有发言权，我被骂了十年。你难受不是因为那几句话，是因为你还在意骂你那几个人——可我这边评论区一天几千条，我要是每条都在意，早不干活了。骂你的人比夸你的人更舍得花时间，这时间就是流量，收着。',
    mode: 'long', want: true, why: '另一条 dry-run 长答：没有反问句，但转述与「我」都在 —— 用来锁住"反问只给 WARN"',
  },
  { text: '这个问题很复杂，客观来说要看你的实际情况。建议你先做职业规划，再决定。', mode: 'long', want: false, why: '没转述、没「我」、给建议' },
];

export function runSelftest({ verbose = true } = {}) {
  let bad = 0;
  const rows = [];
  for (const c of SELFTEST) {
    const r = checkQA(c.text, c.mode);
    const ok = r.fails === 0 === c.want;
    if (!ok) bad++;
    if (verbose) {
      console.log(`${ok ? '✓' : '✗'} 期望 ${c.want ? 'PASS' : 'FAIL'} / 实际 ${r.fails === 0 ? 'PASS' : 'FAIL'} — ${c.why}`);
      for (const f of r.results.filter((x) => x.level === 'FAIL')) console.log(`      ↳ [${f.rule}] ${f.msg}`);
    }
    rows.push({ want: c.want, got: r.fails === 0, why: c.why });
  }
  return { rows, total: SELFTEST.length, mismatched: bad };
}

function format(rep) {
  const icon = { FAIL: '✗ FAIL', WARN: '! WARN', PASS: '✓ pass' };
  const lines = [`问答体自检 · ${rep.mode} · ${rep.len} 字 · FAIL ${rep.fails} / WARN ${rep.warns}`, ''];
  for (const r of rep.results) {
    if (r.level === 'PASS') continue;
    lines.push(`${icon[r.level]}  [${r.rule}] ${r.msg}${r.evidence ? `\n         ↳ ${r.evidence}` : ''}`);
  }
  if (rep.fails === 0 && rep.warns === 0) lines.push('✓ 全部通过');
  lines.push('', '人工自检 3 道（脚本测不了）：①这一题他会不会答（33 条里只有 10 条真给信息）②落点是不是一个词/一句挡回 ③有没有在当好人');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

  if (argv.includes('--selftest')) {
    const r = runSelftest();
    console.log(`\nselftest：${r.total - r.mismatched}/${r.total} 符合预期`);
    process.exit(r.mismatched ? 1 : 0);
  }

  const mode = arg('--mode', 'short');
  const file = arg('--file', null);
  const text = arg('--text', null) ?? (file ? fs.readFileSync(file, 'utf8') : null);
  if (text == null) {
    console.error('用法：--text "文案" --mode short|long ｜ --file x.txt --mode long ｜ --selftest [--json]');
    process.exit(2);
  }
  const rep = checkQA(text, mode);
  const ignore = (arg('--ignore', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ignore.length) {
    const hit = (r) => ignore.some((i) => r.rule.includes(i));
    rep.results = rep.results.filter((r) => !hit(r));
    rep.fails = rep.results.filter((r) => r.level === 'FAIL').length;
    rep.warns = rep.results.filter((r) => r.level === 'WARN').length;
  }
  if (argv.includes('--json')) console.log(JSON.stringify(rep, null, 2));
  else console.log(format(rep));
  process.exit(rep.fails ? 1 : 0);
}
