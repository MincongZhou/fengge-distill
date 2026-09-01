"use strict";
// 从 fg_fengge_500_enriched.jsonl 按 move/topic/hot/日期 筛选，可选附高赞热评、落盘。
// 用法：
//   node fg_query.js --move 自问自答 --limit 5
//   node fg_query.js --topic A股/科技 --limit 5
//   node fg_query.js --hot 1 --move 抽奖运营 --comments --limit 5
//   node fg_query.js --date-from 2026-08-01 --date-to 2026-08-30 --limit 10
//   node fg_query.js --move 随手 --out 随手甩.md
const fs = require("fs");
const base = "C:/Users/ASUS/Documents/dsh Project/dsh-chact/";

function argValue(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; }
const has = (n) => process.argv.includes(n);
const move = argValue("--move");
const topic = argValue("--topic");
const hotS = argValue("--hot");
const df = argValue("--date-from");
const dt = argValue("--date-to");
const limit = parseInt(argValue("--limit") || "20", 10);
const wantComments = has("--comments");
const out = argValue("--out");

const rows = fs.readFileSync(base + "fg_fengge_500_enriched.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const hotMap = {};
try {
  const hj = JSON.parse(fs.readFileSync(base + "fg_fengge_500_hotcomments.json", "utf8"));
  for (const p of hj) if (p.hotComments) hotMap[p.id] = p.hotComments;
} catch (e) { /* no comments */ }

let r = rows.filter((x) => {
  if (move && !x.move.includes(move)) return false;
  if (topic && !x.topics.some((t) => t.includes(topic))) return false;
  if (hotS !== undefined && (hotS === "1") !== !!x.hot) return false;
  if (df && x.date < df) return false;
  if (dt && x.date > dt) return false;
  return true;
});
const total = r.length;
if (r.length > limit) r = r.slice(0, limit);

let md = "";
const print = (s) => { console.log(s); md += s + "\n"; };
const cond = [move && "move=" + move, topic && "topic=" + topic, hotS && "hot=" + hotS, df && "from=" + df, dt && "to=" + dt].filter(Boolean).join(", ");
print("命中 " + total + " 条" + (cond ? "（" + cond + "）" : "") + (total > limit ? "，展示前 " + limit + " 条" : ""));
for (const x of r) {
  print("\n## " + x.date + " | " + x.move + " | " + (x.topics.join("、") || "无") + " | hot=" + x.hot + " | 评" + x.comments + " 赞" + x.attitudes);
  print(x.text);
  if (wantComments) {
    const hs = hotMap[x.id] || [];
    if (hs.length) print("  热评(≥30赞): " + hs.slice(0, 4).map((h) => "+" + h.like + " " + h.u + "：" + h.t).join(" / "));
  }
}
if (out) { fs.writeFileSync(base + out, md, "utf8"); print("\n✅ 已写入 " + out); }
