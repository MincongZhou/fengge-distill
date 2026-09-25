#!/usr/bin/env node
/**
 * fengge-lint — 峰哥体「发稿前自检」
 *
 * 每条规则都来自语料实测，出处见 SKILL.md 参数节 / references/evolution.md：
 *   免责句     他本人 0.5%（10/1870）；账号已发峰哥体 8/9 条都挂 → 上限「每 5 条最多 1 条」
 *   你们…我…   他 0.6%（"你们"任意出现也只 2.2%）；账号上 5/9 条 → 禁
 *   换行       1914 条里 0 条 → 禁
 *   方括号表情  1914 条里 0 条（图形 emoji 反而 3.7%）→ 禁
 *   直播语域   对吧 / 对不对 / 我跟你说 是直播专属（每万字 4.9 / 2.7 / 1.6；微博 0.1 / 0.3 / 0.1）→ 禁
 *   长度       解封后 p50=37 / p75=70 / p90=120；封禁前 p50=51 / p75=102 / p95=149
 *
 * 用法：
 *   node fengge-lint.mjs --text "文案"
 *   node fengge-lint.mjs --file post.txt [--version 2025] [--json]
 *   node fengge-lint.mjs --regress            # 用历史已发文案跑基线
 * 退出码：0 = 无 FAIL；1 = 有 FAIL
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');

// 形态取自语料分层（见 references/style-profile.md）：
//   short = 原创非长文 1568 条：p10=13 / p50=41 / p75=68 / p90=103 / max=151；<14 字的极短帖占 12%
//   long  = isLong 长微博 257 条：中位 147、p90=153、max=187
const LEN = {
  short: { floor: 2, softMin: 14, softMax: 68, warnMax: 103, hardMax: 151, note: '原创非长文 p50=41 / p75=68 / p90=103 / max=151；他另有 12% 的 3–14 字一行帖（最短 3 字「太帅了」）' },
  long: { floor: 120, softMin: 140, softMax: 155, warnMax: 165, hardMax: 200, note: 'isLong 长微博 257 条：中位 147 / p90=153 / max=187' },
};

const DISCLAIMER = /个人观点|个人看法|个人判断|个人猜测|不构成[^。！？]{0,8}建议|风险自担/;
const JUDGEMENT = /点位|价位|预测|剑指|看到\d|突破\d|回不到\d|赛道|板块|概念|大概率/;
const AI_FORMAL = /然而|因此|综上|总的来说|总而言之|值得注意的是|众所周知|不可否认|从某种程度上|首先[，,].{0,40}其次|赋能|抓手|生态位|闭环/;
const WATCH_ONLY = /国乒|乒乓|孙颖莎|王楚钦|樊振东|张本智和|网球|郑钦文|篮球|NBA|理想汽车|蔚来|奕境|问界|乾崑|比亚迪/;
const LIVE_REGISTER = /对吧|对不对|我跟你说/;
// 假口头禅：这些说法在 1914 条全量里是 0 条，全是账号/AI 自己造的（见 references/style-profile.md）
const FAKE_PHRASE = /我算了|算了算|算下来|这账|算账|算一算|盘算|换算成|建议大家|建议你们|够我买|别急|评论区见|谁蹭谁|白赚|茶叶蛋|性价比|本质上|综上所述/;
const DUIZHANG = /你们[^。！？\n]{0,30}我/;

function check(text, version = '2026', form = 'short') {
  const t = String(text ?? '').trim();
  const body = t.replace(/[\u200b\ufeff]/g, '');
  const len = [...body].length;
  const out = [];
  const add = (level, rule, msg, evidence) => out.push({ level, rule, msg, evidence: evidence ?? '' });

  // 硬格式
  const nl = (body.match(/\n/g) || []).length;
  if (nl > 0) add('FAIL', '换行', `出现 ${nl} 处换行`, '他 1914 条里 0 条换行——LLM 最易露馅的一条');
  else add('PASS', '换行', '单段无换行', '');

  // 长度（按形态：短帖 / 长文）
  const L = LEN[form] || LEN.short;
  if (len < L.floor) add('FAIL', '长度', `${len} 字 < 下限 ${L.floor}`, L.note);
  else if (len > L.hardMax) add('FAIL', '长度', `${len} 字 > 语料硬墙 ${L.hardMax}`, L.note);
  else if (len > L.warnMax) add('WARN', '长度', `${len} 字超出 p90=${L.warnMax}`, L.note);
  else if (len > L.softMax) add('WARN', '长度', `${len} 字超出默认区间 ${L.softMin}–${L.softMax}`, `他 ${form === 'short' ? '短帖' : '长文'} p75=${L.softMax}；写这么长要有理由`);
  else if (form === 'short' && len < L.softMin) add('WARN', '长度·极短帖', `${len} 字（他 12% 的帖子就是这么短）`, '确认是故意甩一句就发；要写完整观点就补到 14 字以上');
  else add('PASS', '长度', `${len} 字（${form === 'short' ? '短帖' : '长文'} ${L.softMin}–${L.softMax} 为默认区）`, '');

  // 对仗
  const dz = body.match(DUIZHANG);
  if (dz) add('FAIL', '你们…我…对仗', `命中：「${dz[0]}」`, '他 0.6%，账号上 5/9 条——第二大 AI 味');
  else add('PASS', '你们…我…对仗', '无', '');
  if (!dz && /你们/.test(body)) add('WARN', '「你们」', `出现 ${(body.match(/你们/g) || []).length} 次`, '他任意出现也只 2.2%，更常说「你」或直接说「我」');

  // 直播语域
  const lr = body.match(new RegExp(LIVE_REGISTER.source, 'g'));
  if (lr) add('FAIL', '直播语域', `命中 ${[...new Set(lr)].join(' / ')}`, '对吧/对不对/我跟你说 是直播专属，写微博加立刻露馅');
  else add('PASS', '直播语域', '无直播专属词', '');

  // 表情
  const br = body.match(/\[[^\]\s]{1,6}\]/g);
  if (br) add('FAIL', '方括号表情', `命中 ${br.join(' ')}`, '1914 条里方括号表情 0 条——要加只用图形 emoji，且仅 3.7% 的帖子有');
  else add('PASS', '方括号表情', '无', '');
  const emo = body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
  if (emo.length > 1) add('WARN', '图形 emoji', `${emo.length} 个`, '他只有 3.7% 的帖子带，且基本 1 个');

  // 标点与节奏（1568 条原创短帖实测：49.9% 结尾不加标点，句号收尾仅 27.6%）
  const ending = [...body].slice(-1)[0] || '';
  if (ending === '。') add('WARN', '结尾标点', '以「。」收尾', '他只有 27.6% 的短帖这样收尾，49.9% 干脆不加标点——LLM 的默认动作正好是最不像他的那个');
  if (/、/.test(body)) add('WARN', '顿号', '用了「、」', '顿号只出现在 0.7% 的帖子里');
  if (/；/.test(body)) add('WARN', '分号', '用了「；」', '分号只出现在 1.0% 的帖子里');
  if (/！！|？？|！？|？！|！…/.test(body)) add('WARN', '标点连用', '感叹号/问号连用', '连用感叹号 0.1%、问号连用 0.0%');

  // 假口头禅（语料里 0 条的说法）
  const fake = body.match(new RegExp(FAKE_PHRASE.source, 'g'));
  if (fake) add('FAIL', '假口头禅', `命中 ${[...new Set(fake)].join(' / ')}`, '这些说法在 1914 条全量里 0 条——不是他的词，是账号/AI 造的');
  else add('PASS', '假口头禅', '无', '');

  // AI 书面词
  const formal = body.match(new RegExp(AI_FORMAL.source, 'g'));
  if (formal) add('WARN', '书面/AI 味词', `命中 ${[...new Set(formal)].join(' / ')}`, '他不写书面连接词');
  else add('PASS', '书面/AI 味词', '无', '');

  // 免责句
  if (DISCLAIMER.test(body)) {
    const last = body.split(/[。！？]/).filter(Boolean).pop() || '';
    const atEnd = DISCLAIMER.test(last);
    add(atEnd ? 'WARN' : 'FAIL', '免责句',
      atEnd ? '挂在句末（合规用法）' : '出现但不在末句',
      '他本人全量 0.5%（10/1870）；上限每 5 条最多 1 条，且只挂「判断/预测」');
    if (atEnd && !JUDGEMENT.test(body)) add('WARN', '免责句·挂载对象', '这条没有具体判断/预测', '他挂的是点位/价位/赛道断言，不挂晒单和生活帖');
  } else {
    add('PASS', '免责句', '未挂（默认应当如此）', '他全量只有 0.5% 挂');
  }

  // 数字
  if (!/\d/.test(body)) add('WARN', '数字', '无任何数字', '他 40% 的帖子含数字；精确到个位带单位最像他');
  else add('PASS', '数字', '含数字', '');

  // 话题标签
  const tags = body.match(/#[^#\n]{2,}#/g) || [];
  if (tags.length > 2) add('WARN', '话题标签', `${tags.length} 个`, '他用标签的帖子占 21.7%，一般 0–1 个');

  // 选题器：围观类热点当靶子
  const head = [...body].slice(0, 15).join('');
  const w = head.match(WATCH_ONLY);
  if (w) add('FAIL', '选题器', `以纯围观热点「${w[0]}」起手`, '国乒 0 条 / 网球 1 条 / 华为系车 2 条——他从不写纯围观的比赛和别人的车');
  else if (WATCH_ONLY.test(body)) add('WARN', '选题器', '正文提到围观类热点', '若它只是陪衬可以，当主靶子不行');

  // 人称：他用「我」（短帖 41%）或第三人称自称「峰哥」（长文里更多）
  if (!/我|峰哥/.test(body)) add('WARN', '人称', '既没有「我」也没有「峰哥」', '他 41% 的短帖含「我」，落点必须绕回自己');

  return { len, version, form, results: out, fails: out.filter(r => r.level === 'FAIL').length, warns: out.filter(r => r.level === 'WARN').length };
}

function format(rep) {
  const icon = { FAIL: '✗ FAIL', WARN: '! WARN', PASS: '✓ pass' };
  const lines = [`峰哥体自检 · ${rep.form === 'long' ? '长文' : `短帖·${rep.version}`} · ${rep.len} 字 · FAIL ${rep.fails} / WARN ${rep.warns}`, ''];
  for (const r of rep.results) {
    if (r.level === 'PASS') continue;
    lines.push(`${icon[r.level]}  [${r.rule}] ${r.msg}${r.evidence ? `\n         ↳ ${r.evidence}` : ''}`);
  }
  if (rep.fails === 0 && rep.warns === 0) lines.push('✓ 全部通过');
  lines.push('', '人工自检 6 道（脚本测不了）：①像不像随手打 ②有没有替社会抱不平 ③有没有"又被看穿" ④丧完有没有转 ⑤落点是否绕回"峰哥牛" ⑥先过选题器了吗');
  if (rep.ignored && rep.ignored.length) lines.push(`（按 --ignore 豁免了：${rep.ignored.join(' / ')}）`);
  return lines.join('\n');
}

function appendRun(entry) {
  const results = path.join(SKILL_DIR, 'evals', 'results.json');
  let prev = { runs: [] };
  try {
    const j = JSON.parse(fs.readFileSync(results, 'utf8'));
    if (Array.isArray(j.runs)) prev = j;
  } catch { /* 空文件/半截 JSON（进程被中断）→ 重开一份 */ }
  prev.runs.push(entry);
  fs.writeFileSync(results, JSON.stringify(prev, null, 2));
  return results;
}

export function regressData() {
  const f = path.join(SKILL_DIR, 'evals', 'samples', 'published.json');
  if (!fs.existsSync(f)) throw new Error('缺少回归样本：' + f);
  const samples = JSON.parse(fs.readFileSync(f, 'utf8'));
  const withDis = samples.filter(s => DISCLAIMER.test(s.text)).length;
  const rows = samples.map(s => {
    const r = check(s.text, '2026');
    return { date: s.date, reads: s.reads, len: r.len, fails: r.fails, warns: r.warns, rules: [...new Set(r.results.filter(x => x.level === 'FAIL').map(x => x.rule))] };
  });
  return { rows, withDis, total: rows.length, failed: rows.filter(r => r.fails > 0).length };
}

function regress() {
  const { rows, withDis, total, failed } = regressData();
  console.log(`回归基线：${total} 条历史已发峰哥体（2026-08-29 ~ 09-19，账号 皮皮true）`);
  console.log(`按新规则：${failed}/${total} 条 FAIL，${rows.filter(r => r.warns > 0).length}/${total} 条 WARN`);
  console.log(`其中挂免责声明的：${withDis}/${total}（他本人全量 0.5%，上限应为每 5 条 1 条）\n`);
  for (const r of rows) console.log(`${r.fails ? '✗' : '✓'} ${r.date}  ${String(r.len).padStart(3)} 字  reads=${String(r.reads).padStart(6)}  FAIL=${r.fails} WARN=${r.warns}  ${r.rules.join(' + ')}`);
  const p = appendRun({ at: new Date().toISOString(), kind: 'regress', total, failed, rows });
  console.log(`\n结果已追加到 ${path.relative(process.cwd(), p)}`);
  process.exit(failed ? 1 : 0);
}

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

// 作为脚本直接运行时才走 CLI；被 evals/run-evals.mjs import 时只导出 check/format
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export { check, format, LEN };

if (invokedDirectly) {
  if (argv.includes('--regress')) regress();

  const version = arg('--version', '2026');
  const form = arg('--form', 'short');
  const file = arg('--file', null);
  const text = arg('--text', null) ?? (file ? fs.readFileSync(file, 'utf8') : null);
  if (text == null) {
    console.error('用法：node fengge-lint.mjs --text "文案" | --file post.txt | --regress [--form short|long] [--ignore 规则] [--json]');
    process.exit(2);
  }
  const rep = check(text, version, form);
  // --ignore 选题器[,长度]: 靶子由人指定时，允许豁免某些规则（默认不豁免）
  const ignore = (arg('--ignore', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ignore.length) {
    const hit = r => ignore.some(i => r.rule.includes(i));
    const dropped = rep.results.filter(r => r.level !== 'PASS' && hit(r)).map(r => r.rule);
    rep.results = rep.results.filter(r => !hit(r));
    rep.fails = rep.results.filter(r => r.level === 'FAIL').length;
    rep.warns = rep.results.filter(r => r.level === 'WARN').length;
    rep.ignored = [...new Set(dropped)];
  }
  if (argv.includes('--json')) console.log(JSON.stringify(rep, null, 2));
  else console.log(format(rep));
  appendRun({ at: new Date().toISOString(), kind: 'lint', version, len: rep.len, fails: rep.fails, warns: rep.warns, rule: rep.results.filter(r => r.level !== 'PASS').map(r => r.rule) });
  process.exit(rep.fails ? 1 : 0);
}
