"use strict";
// 离线筛选：读仓库内 data/sample.jsonl，无需登录态。可独立跑 / 跑 CI。
//
// ⚠️ 仓库内 sample.jsonl 只是**12 条抽样**（真语料 1921 条不随仓库分发）。
// 所以 README 里 `--move 自问自答 → 命中 21 条` 说的是全量语料，在这 12 条上命中 0 是正常的。
// 想在 CI 里拿它当冒烟测试，必须给 --min-hits，否则"命中 0 条"也会 exit 0——
// 那就是一条绿得毫无内容的测试（本仓库把这种叫"沉默的测试"）。
//
// 用法：node scripts/query.js --move 体育格斗蹭 --limit 5 --min-hits 1
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "data");
function argValue(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; }
const has = (n) => process.argv.includes(n);
const move = argValue("--move");
const topic = argValue("--topic");
const hotS = argValue("--hot");
const df = argValue("--date-from");
const dt = argValue("--date-to");
const limit = parseInt(argValue("--limit") || "20", 10);
const minHits = argValue("--min-hits") === undefined ? null : parseInt(argValue("--min-hits"), 10);
const wantComments = has("--comments");
const out = argValue("--out");

const rows = fs.readFileSync(path.join(DATA, "sample.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
let hotMap = {};
try {
  const hj = JSON.parse(fs.readFileSync(path.join(DATA, "hotcomments.json"), "utf8"));
  for (const p of hj) if (p.hotComments) hotMap[p.id] = p.hotComments;
} catch (e) { /* 仓库无 hotcomments.json 时跳过 */ }

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
if (total === 0) {
  // 只喊"命中 0 条"没法排查：把这份样本里真实存在的取值列出来，一眼就知道是筛选写错了还是样本没有
  const moves = [...new Set(rows.map((x) => x.move))].sort();
  const topics = [...new Set(rows.flatMap((x) => x.topics || []))].sort();
  print("  这条样本共 " + rows.length + " 行。可用的 move：" + moves.join(" / "));
  print("  可用的话题：" + topics.join(" / "));
}
for (const x of r) {
  print("\n## " + x.date + " | " + x.move + " | " + (x.topics.join("、") || "无") + " | hot=" + x.hot + " | 评" + x.comments + " 赞" + x.attitudes);
  print(x.text);
  if (wantComments) {
    const hs = hotMap[x.id] || [];
    if (hs.length) print("  热评(≥30赞): " + hs.slice(0, 4).map((h) => "+" + h.like + " " + h.u + "：" + h.t).join(" / "));
  }
}
if (out) { fs.writeFileSync(path.resolve(out), md, "utf8"); print("\n✅ 已写入 " + out); }
// --min-hits：低于下限就非零退出，好让 CI 的冒烟测试真的能拦住"筛选条件写错了导致空结果"
if (minHits !== null && total < minHits) {
  console.error("✗ 命中 " + total + " 条，低于 --min-hits " + minHits);
  process.exit(1);
}
