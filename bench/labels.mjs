#!/usr/bin/env node
/**
 * labels.mjs — 人工标注：盲评表生成 + 胜率 / Cohen κ 计算。
 *
 * 为什么以**成对盲评**为主判据：绝对打分（"这条像不像，1–5 分"）对同一批人重测一致性很差，
 * 而且很受"一次看多少条"影响。两条匿名文案二选一（哪条更像真人）判断更稳、更接近真实使用场景。
 * 绝对标注（像不像 / 有没有串子味）作为次要判据，用来算与出处弱标签的一致性。
 *
 * 两件工具：
 *   1) sheet  —— 生成自包含 HTML 盲评表（浏览器里点，localStorage 存草稿，可导出 JSON）
 *                + 一份 CSV 兜底（不想开浏览器就在表格里填）。
 *                **页面里不出现任何条件名**（不写"这是我们的管线"），A/B 顺序按固定种子随机，
 *                映射关系单独写进 report/pair-key.json，只在算分时用 —— 盲评要盲的是"哪条是我们的"。
 *   2) score  —— 读导出的 answers.json，算人工胜率（Wilson 95% 区间）与人工/弱标签的 Cohen κ。
 *
 * 用法：
 *   node bench/labels.mjs sheet --run <runId>
 *   node bench/labels.mjs score --answers <answers.json>
 *   node bench/labels.mjs score --answers <answers.json> --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSampler } from './items.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, 'report');
export const ITEMS_FILE = path.join(HERE, 'items.jsonl');

// ---------------------------------------------------------------- 统计工具

/** Wilson 95% 区间（小样本比例比正态近似稳） */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

/**
 * Cohen's κ。po = 观察一致率，pe = 偶然一致率。
 * 返回的 band 用 Landis & Koch 的常用分档，方便读。
 */
export function cohenKappa(pairs) {
  const n = pairs.length;
  if (!n) return { n: 0, po: 0, pe: 0, kappa: 0, band: '无数据' };
  let agree = 0, a1 = 0, b1 = 0;
  for (const [a, b] of pairs) {
    if (a === b) agree++;
    if (a === 1) a1++;
    if (b === 1) b1++;
  }
  const po = agree / n;
  const pe = (a1 / n) * (b1 / n) + (1 - a1 / n) * (1 - b1 / n);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  const k = +kappa.toFixed(4);
  const band = k < 0 ? '差于随机' : k < 0.21 ? '轻微' : k < 0.41 ? '一般' : k < 0.61 ? '中等' : k < 0.81 ? '较强' : '几乎一致';
  return { n, po: +po.toFixed(4), pe: +pe.toFixed(4), kappa: k, band };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------- 盲评表

/** A/B 配对：同一题目下 base 档 vs 管线档，逐题配对才可比 */
export function buildPairs(runDir, { left = 'c0-base', right = 'c2-retrieval', seed = 7717 } = {}) {
  const read = (cond) => {
    const dir = path.join(runDir, cond);
    if (!fs.existsSync(dir)) return new Map();
    return new Map(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
  };
  const L = read(left), R = read(right);
  const rand = makeSampler(seed);
  const pairs = [];
  for (const id of [...L.keys()].filter((k) => R.has(k)).sort()) {
    const flip = rand(2) === 0;      // 固定种子决定左右，且与内容无关
    pairs.push({
      pairId: `pair-${id}`,
      topicId: id,
      topic: L.get(id).topic,
      key: flip ? { A: right, B: left } : { A: left, B: right },   // 只在 pair-key.json 里出现
      A: flip ? R.get(id).text : L.get(id).text,
      B: flip ? L.get(id).text : R.get(id).text,
    });
  }
  return { pairs, left, right };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function sheetHtml({ items, pairs, meta }) {
  const itemsJs = JSON.stringify(items.map((i) => ({ id: i.id, text: i.text })));
  const pairsJs = JSON.stringify(pairs.map((p) => ({ pairId: p.pairId, topic: p.topic, A: p.A, B: p.B })));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>峰哥体评测 · 盲评表</title>
<style>
 :root{--bg:#faf8f5;--card:#fff;--line:#e6e0d8;--ink:#2b2724;--dim:#8a8078;--acc:#8b5e34}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:12px 20px;z-index:5;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
 h1{font-size:16px;margin:0;font-weight:600}
 .bar{font-size:13px;color:var(--dim)}
 button{font:inherit;cursor:pointer;border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 12px}
 button.on{background:var(--acc);border-color:var(--acc);color:#fff}
 main{max-width:900px;margin:0 auto;padding:20px}
 section{margin-bottom:36px}
 h2{font-size:15px;border-left:3px solid var(--acc);padding-left:8px;margin:24px 0 12px}
 .item{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
 .txt{white-space:pre-wrap;margin-bottom:10px}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--dim)}
 .pair .side{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:6px 0}
 .side b{color:var(--acc);font-weight:600}
 .pair button{margin-right:6px}
 footer{max-width:900px;margin:0 auto;padding:20px;color:var(--dim);font-size:13px}
 .note{background:#fff9ef;border:1px solid #f0e0c8;border-radius:10px;padding:12px 14px;font-size:13px;color:#6b5a44}
</style></head><body>
<header>
  <h1>峰哥体评测 · 盲评表</h1>
  <span class="bar" id="prog">—</span>
  <button onclick="dl()">导出标注结果</button>
  <button onclick="if(confirm('清空全部标注？')){localStorage.removeItem(KEY);location.reload()}">清空</button>
</header>
<main>
<div class="note">
  <b>怎么标</b>：第一部分每条独立判断「像不像 @峰哥亡命天涯 发的微博」和「有没有串子味」。<br>
  第二部分是<b>成对盲评</b>：A/B 两条匿名文案（同一题目下的两种写法），选「哪条更像真人发的」。<br>
  标注只存在你本机浏览器里（localStorage），随时点右上角导出 JSON，交给 <code>node bench/labels.mjs score</code> 算胜率和一致性。<br>
  不知道选哪个就选「分不出」——那是有效答案，别硬选。
</div>
<h2>第一部分 · 单条判断（${items.length} 条）</h2>
<section id="items"></section>
<h2>第二部分 · 成对盲评（${pairs.length} 对）</h2>
<section id="pairs"></section>
</main>
<footer>
语料与生成结果的出处见 <code>bench/report/items-summary.json</code> 与 <code>bench/runs/</code>；
本页不显示任何条件名（盲评要盲的是"哪条是我们的"），A/B 映射只存在于 <code>pair-key.json</code>，算分时才用。
</footer>
<script>
const KEY='fengge-labels-v1';
const ITEMS=${itemsJs}, PAIRS=${pairsJs};
const S=JSON.parse(localStorage.getItem(KEY)||'{"items":{},"pairs":{}}');
const save=()=>{localStorage.setItem(KEY,JSON.stringify(S));prog()};
function prog(){
  const ni=ITEMS.filter(i=>S.items[i.id]&&(S.items[i.id].like_fengge!=null||S.items[i.id].chuanzi!=null)).length;
  const np=Object.values(S.pairs).filter(Boolean).length;
  document.getElementById('prog').textContent='已标 '+ni+'/'+ITEMS.length+' 条 ｜ 已选 '+np+'/'+PAIRS.length+' 对';
}
function setItem(id,field,val){S.items[id]=S.items[id]||{};S.items[id][field]=val;save();render()}
function setPair(id,val){S.pairs[id]=val;save();render()}
function btn(on,label,fn){return '<button class="'+(on?'on':'')+'" onclick="'+fn+'">'+label+'</button>'}
function render(){
  document.getElementById('items').innerHTML=ITEMS.map((it,n)=>{
    const s=S.items[it.id]||{};
    return '<div class="item"><div class="row"><b>#'+(n+1)+'</b></div>'+
      '<div class="txt">'+it.text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</div>'+
      '<div class="row"><span>像不像：</span>'+btn(s.like_fengge===1,'像',"setItem('"+it.id+"','like_fengge',1)")+btn(s.like_fengge===0,'不像',"setItem('"+it.id+"','like_fengge',0)")+'</div>'+
      '<div class="row" style="margin-top:6px"><span>串子味：</span>'+btn(s.chuanzi===1,'有',"setItem('"+it.id+"','chuanzi',1)")+btn(s.chuanzi===0,'没有',"setItem('"+it.id+"','chuanzi',0)")+'</div>'+
      '</div>';
  }).join('');
  document.getElementById('pairs').innerHTML=PAIRS.map((p,n)=>{
    const s=S.pairs[p.pairId];
    return '<div class="item pair"><div class="row"><b>第 '+(n+1)+' 对</b>　题目：'+p.topic+'</div>'+
      '<div class="side"><b>A</b><div class="txt">'+p.A.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</div></div>'+
      '<div class="side"><b>B</b><div class="txt">'+p.B.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</div></div>'+
      '<div class="row">哪条更像真人发的：'+btn(s==='A','A 更像',"setPair('"+p.pairId+"','A')")+btn(s==='B','B 更像',"setPair('"+p.pairId+"','B')")+btn(s==='tie','分不出',"setPair('"+p.pairId+"','tie')")+'</div></div>';
  }).join('');
}
function dl(){
  const blob=new Blob([JSON.stringify({at:new Date().toISOString(),items:S.items,pairs:S.pairs},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='fengge-labels.json';a.click();
}
render();prog();
</script></body></html>`;
}

// ---------------------------------------------------------------- CLI

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const cmd = argv[0];

  if (cmd === 'sheet') {
    const runId = arg('--run');
    if (!runId) { console.error('用法：sheet --run <runId>'); process.exit(2); }
    const runDir = path.join(HERE, 'runs', runId);
    if (!fs.existsSync(runDir)) { console.error(`没有这次运行：${runDir}`); process.exit(2); }
    if (!fs.existsSync(ITEMS_FILE)) { console.error(`缺少 ${ITEMS_FILE}，先跑：node bench/items.mjs --run ${runId}`); process.exit(2); }
    const items = fs.readFileSync(ITEMS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const { pairs, left, right } = buildPairs(runDir, { seed: Number(arg('--seed', 7717)) });
    fs.mkdirSync(REPORT, { recursive: true });
    fs.writeFileSync(path.join(REPORT, 'label-sheet.html'), sheetHtml({
      items, pairs,
      meta: { runId, left, right, generatedAt: new Date().toISOString() },
    }));
    // 映射单独落盘：页面里只有 A/B 文本，不含任何条件名
    fs.writeFileSync(path.join(REPORT, 'pair-key.json'), JSON.stringify({
      runId, left, right, seed: Number(arg('--seed', 7717)),
      generatedAt: new Date().toISOString(),
      note: 'A/B → 条件是给 score 用的，不要在看表前打开这个文件（盲评要盲的是"哪条是我们的"）',
      pairs: pairs.map((p) => ({ pairId: p.pairId, topicId: p.topicId, topic: p.topic, A: p.key.A, B: p.key.B })),
    }, null, 2));
    // CSV 兜底：不想开浏览器就在表格里填
    const csv = ['id,class,chars,text,like_fengge,chuanzi',
      ...items.map((i) => [i.id, i.class, i.chars, `"${String(i.text).replace(/"/g, '""')}"`, '', ''].join(','))];
    fs.writeFileSync(path.join(REPORT, 'labels.csv'), '\ufeff' + csv.join('\n') + '\n');

    console.log(`盲评表：bench/report/label-sheet.html（${items.length} 条 + ${pairs.length} 对盲评）`);
    console.log(`CSV 兜底：bench/report/labels.csv（Excel 可直接开，带 BOM 防中文乱码）`);
    console.log(`A/B 映射：bench/report/pair-key.json（**算分前别看**，否则盲评作废）`);
    console.log(`配对：${left} vs ${right}，同一题目逐题配对，共 ${pairs.length} 对`);
    process.exit(0);
  }

  if (cmd === 'score') {
    const answersFile = arg('--answers');
    if (!answersFile || !fs.existsSync(answersFile)) { console.error('用法：score --answers <answers.json>'); process.exit(2); }
    // 容忍 BOM：Windows 上用 PowerShell 的 Set-Content -Encoding UTF8 或某些编辑器导出都会带 BOM，
    // 而 JSON.parse 会在第一个字符就炸（'\uFEFF{' 不是合法 JSON）。这类文件是**用户手工产物**，
    // 不能指望它干净——在这里剥掉，比让人去查"为什么我的 JSON 解析不了"划算。
    const rawAnswers = fs.readFileSync(answersFile, 'utf8').replace(/^\uFEFF/, '');
    let A;
    try {
      A = JSON.parse(rawAnswers);
    } catch (e) {
      console.error(`标注文件不是合法 JSON：${answersFile}\n  ${e.message}\n  提示：它应当是盲评表右上角"导出标注结果"下载的那个文件。`);
      process.exit(2);
    }
    const items = fs.readFileSync(ITEMS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const keyFile = path.join(REPORT, 'pair-key.json');
    const key = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : null;

    const out = { at: new Date().toISOString(), answers: answersFile, items: {}, pairs: {}, kappa: {} };

    // --- 单条：按类别看人工判"像"的比例 ---
    const byClass = {};
    for (const it of items) {
      const a = A.items?.[it.id];
      if (!a) continue;
      byClass[it.class] ||= { n: 0, like: 0, chuanzi: 0, likeJudged: 0, chuanziJudged: 0 };
      const c = byClass[it.class];
      c.n++;
      if (a.like_fengge === 0 || a.like_fengge === 1) { c.likeJudged++; c.like += a.like_fengge; }
      if (a.chuanzi === 0 || a.chuanzi === 1) { c.chuanziJudged++; c.chuanzi += a.chuanzi; }
    }
    for (const [k, c] of Object.entries(byClass)) {
      out.items[k] = {
        n: c.n,
        likeRate: c.likeJudged ? +(c.like / c.likeJudged).toFixed(4) : null,
        likeCI: c.likeJudged ? wilson(c.like, c.likeJudged).map((x) => +x.toFixed(4)) : null,
        chuanziRate: c.chuanziJudged ? +(c.chuanzi / c.chuanziJudged).toFixed(4) : null,
      };
    }

    // --- 人工 vs 出处弱标签：Cohen κ（只用 confidence=high 的条目） ---
    const pairsLike = [], pairsChuanzi = [];
    for (const it of items) {
      if (it.weak?.confidence !== 'high') continue;
      const a = A.items?.[it.id];
      if (!a) continue;
      if ((a.like_fengge === 0 || a.like_fengge === 1) && (it.weak.like_fengge === 0 || it.weak.like_fengge === 1)) {
        pairsLike.push([a.like_fengge, it.weak.like_fengge]);
      }
      if ((a.chuanzi === 0 || a.chuanzi === 1) && (it.weak.chuanzi === 0 || it.weak.chuanzi === 1)) {
        pairsChuanzi.push([a.chuanzi, it.weak.chuanzi]);
      }
    }
    out.kappa.like_fengge = cohenKappa(pairsLike);
    out.kappa.chuanzi = cohenKappa(pairsChuanzi);

    // --- 成对盲评 → 胜率 ---
    if (key) {
      let win = 0, loss = 0, tie = 0, missing = 0;
      for (const p of key.pairs) {
        const pick = A.pairs?.[p.pairId];
        if (!pick) { missing++; continue; }
        if (pick === 'tie') { tie++; continue; }
        const pickedCond = pick === 'A' ? p.A : p.B;
        if (pickedCond === key.right) win++;
        else if (pickedCond === key.left) loss++;
      }
      const decided = win + loss;
      out.pairs = {
        left: key.left, right: key.right,
        win, loss, tie, missing, decided,
        winRate: decided ? +(win / decided).toFixed(4) : null,
        winRateCI: decided ? wilson(win, decided).map((x) => +x.toFixed(4)) : null,
        tieRate: (win + loss + tie) ? +(tie / (win + loss + tie)).toFixed(4) : null,
      };
    } else {
      out.pairs = { error: '缺少 bench/report/pair-key.json —— 无法把 A/B 还原成条件，胜率算不出来。' };
    }

    fs.mkdirSync(REPORT, { recursive: true });
    fs.writeFileSync(path.join(REPORT, 'labels-score.json'), JSON.stringify(out, null, 2));

    if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

    console.log('人工标注结果\n');
    console.log('一、单条判断（按类别）');
    console.log('类别'.padEnd(16) + '已标'.padEnd(6) + '判「像」比例'.padEnd(14) + '95% 区间'.padEnd(18) + '判「有串子味」');
    for (const [k, r] of Object.entries(out.items)) {
      console.log(k.padEnd(16) + String(r.n).padEnd(6)
        + (r.likeRate == null ? '—' : pct(r.likeRate)).padEnd(14)
        + (r.likeCI ? `[${pct(r.likeCI[0])}, ${pct(r.likeCI[1])}]` : '—').padEnd(18)
        + (r.chuanziRate == null ? '—' : pct(r.chuanziRate)));
    }
    console.log('\n二、成对盲评胜率（同一题目逐题配对）');
    if (out.pairs.error) console.log('  ' + out.pairs.error);
    else {
      const p = out.pairs;
      console.log(`  ${p.right} 胜 ${p.win} ／ ${p.left} 胜 ${p.loss} ／ 分不出 ${p.tie} ／ 漏标 ${p.missing}`);
      console.log(`  胜率（排除平局）：${p.winRate == null ? '—' : pct(p.winRate)}${p.winRateCI ? `  95% 区间 [${pct(p.winRateCI[0])}, ${pct(p.winRateCI[1])}]` : ''}`);
      if (p.decided && p.winRateCI && p.winRateCI[0] <= 0.5) console.log('  ⚠️ 区间跨过 50%：按这 ${p.decided} 对还**分不出**两档差距，别急着说谁赢。');
    }
    console.log('\n三、人工判据 vs 出处弱标签（Cohen κ，Landis & Koch 分档）');
    for (const [k, v] of Object.entries(out.kappa)) {
      console.log(`  ${k.padEnd(14)} n=${String(v.n).padEnd(4)} 一致率 ${pct(v.po).padEnd(8)} κ=${v.kappa}  （${v.band}）`);
    }
    console.log(`\n→ bench/report/labels-score.json`);
    process.exit(0);
  }

  console.error('用法：sheet --run <runId> | score --answers <answers.json>');
  process.exit(2);
}
