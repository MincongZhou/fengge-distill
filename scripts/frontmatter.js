"use strict";
// 给峰哥语料打标：move(签名动作)/topics(话题)/hot(有无≥30热评)，生成 front-matter md + JSONL
const fs = require("fs");
const base = "C:/Users/ASUS/Documents/dsh Project/dsh-chact/";
const posts = JSON.parse(fs.readFileSync(base + "fg_fengge_500_raw.json", "utf8"));
const hotIds = new Set();
try {
  const hj = JSON.parse(fs.readFileSync(base + "fg_fengge_500_hotcomments.json", "utf8"));
  for (const p of hj) if (p.hotComments && p.hotComments.length) hotIds.add(p.id);
} catch (e) { /* no hot map */ }

// 签名动作（按优先级，取第一个命中的为主）
const moves = [
  [/善恶终有报|天道好轮回|苍天饶过谁|恶有恶报/, "因果报应"],
  [/实名举报|举报|维权|造谣|法律/, "举报/维权"],
  [/我出5000|出场费|来B站跟我打|打一场|约一架/, "约架/下战书"],
  [/道歉|抱歉|ごめんなさい/, "道歉体"],
  [/报备/, "报备体"],
  [/开始营业|目标赚/, "营业宣言"],
  [/抽.{0,5}(iPhone|手机|红包)|红包|转发.{0,4}关注|中奖|抽奖|抽个/, "抽奖运营"],
  [/不实信息|辟谣|澄清|永远退出互联网|没有.{0,3}(接触|关系|存款|海外|因为钱)/, "辟谣/声明"],
  [/木头椅子|能理解的人不超过|比同龄人|通透了|少数/, "凡尔赛孤独体"],
  [/人形机器人|机器人|宇树|银河通用|机械狗|AI眼镜|为什么要.{0,3}人形|无人机/, "荒诞发明家/机器人"],
  [/你眼中的暴论|很多人的常识|人性就是这样|世间所有事|最怕认真/, "金句暴论"],
  [/理由如下|：1\b|^1\./, "理由如下列点体"],
  [/为什么/, "自问自答"],
  [/骂我|我乐意亏钱|喷子|又哭又闹|你来股市|看不懂|说理/, "回怼喷子"],
  [/刘翔|半马|马拉松|跑步/, "体育自夸"],
  [/UFC|宋亚东|邹市明|KO|刘策|骨头琼斯/, "体育格斗蹭"],
  [/阿根廷|梅西|世界杯|西班牙|卫冕/, "押注/体育"],
  [/我给你.{0,3}(大家|普通人)一个建议|支一招|别听普通人的/, "人生导师"],
  [/满仓|减仓|回本|加仓|持仓|盈利|割肉|买了.{0,4}(黄金|股|币|锂|港币)|抄底|建仓/, "持仓晒单/操作"],
  [/个人观点/, "免责声明体"],
];
const topics = [
  [/A股|股市|上证|大盘|仓位|半导体|光模块|算力|芯片|存储|AI|科技|HBM|液冷|磷化铟/, "A股/科技"],
  [/黄金|金价/, "黄金"],
  [/孙宇晨|孙哥|孙割/, "孙宇晨"],
  [/景甜|大甜甜/, "景甜"],
  [/段永平|段平|步步高|小霸王|ppmt/, "段永平"],
  [/机器人|宇树|银河通用|机械狗|AI眼镜|人形|无人机|具身/, "机器人/AI硬件"],
  [/UFC|宋亚东|邹市明|KO|刘策|骨头琼斯|世界杯|梅西|阿根廷|足球/, "体育"],
  [/电影|影评|龙餐馆|上映|好莱坞/, "影评"],
  [/抽|iPhone|红包|转发|中奖/, "抽奖/红包"],
  [/范冰冰|李小璐|黄景瑜|包贝尔|明星|同框|绯闻/, "明星八卦"],
  [/举报|维权|造谣|实名/, "维权/举报"],
  [/烤鸭|报备|早餐|酒店|吃饭|西瓜|牛杂|机场/, "生活/账单"],
];
function classifyMove(text) {
  for (const [re, name] of moves) if (re.test(text)) return name;
  return "其他/随手甩";
}
function classifyTopics(text) {
  const out = [];
  for (const [re, name] of topics) if (re.test(text)) out.push(name);
  return out;
}

const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function toDate(c) { const f = c.split(" "); const m = MON[f[1]] || "00"; const d = String(Number(f[2])).padStart(2, "0"); const y = f[5]; return y + "-" + m + "-" + d; }

const rows = posts.map((p) => ({
  id: p.id,
  date: toDate(p.created_at),
  created: p.created_at,
  move: classifyMove(p.text),
  topics: classifyTopics(p.text),
  hot: hotIds.has(p.id),
  len: p.text.length,
  reposts: p.reposts,
  comments: p.comments,
  attitudes: p.attitudes,
  text: p.text,
}));

// JSONL
fs.writeFileSync(base + "fg_fengge_500_enriched.jsonl", rows.map((r) => JSON.stringify(r)).join("\n"), "utf8");

// front-matter md
let md = "# 峰哥语料（带 front-matter 元数据，559 条）\n\n";
for (const r of rows) {
  md += "---\nid: " + r.id + "\ndate: " + r.date + "\nmove: " + r.move + "\ntopics: " + (r.topics.join("、") || "-") + "\nhot: " + r.hot + "\nlen: " + r.len + "\n---\n" + r.text + "\n\n";
}
fs.writeFileSync(base + "fg_fengge_500_frontmatter.md", md, "utf8");

// 分布
const moveDist = {}, topicDist = {}; let hotCount = 0;
for (const r of rows) {
  moveDist[r.move] = (moveDist[r.move] || 0) + 1;
  for (const t of r.topics) topicDist[t] = (topicDist[t] || 0) + 1;
  if (r.hot) hotCount++;
}
console.log("总数", rows.length, "| 有≥30热评", hotCount);
console.log("签名动作分布:", JSON.stringify(moveDist, null, 0));
console.log("话题分布:", JSON.stringify(topicDist, null, 0));
console.log("已写 enriched.jsonl + frontmatter.md");
