"use strict";
// 「今日峰哥味」——从 data/sample.jsonl 按当天日期稳定挑一条，无需登录态。可独立跑 / 跑 CI / 当 demo。
// 同一天跑结果固定（按日期取模），跨天自动换。
const fs = require("fs");
const path = require("path");
const rows = fs.readFileSync(path.join(__dirname, "..", "data", "sample.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const d = new Date();
const dayNum = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
const r = rows[dayNum % rows.length];
const dateStr = d.toISOString().slice(0, 10);
console.log("今日峰哥味 · " + dateStr);
console.log("");
console.log(r.text);
console.log("");
console.log("— move: " + r.move + " | topics: " + (r.topics.join("、") || "无") + " | hot=" + r.hot + " | 评" + r.comments + " 赞" + r.attitudes);
