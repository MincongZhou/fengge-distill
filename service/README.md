# `service/` —— 峰哥体蒸馏引擎的服务化包装层

把仓库里**已有的、纯本地的 node 工具**包成 HTTP 接口。**它不重新实现任何算法。**

---

## 1. 边界：为什么这一层在包外

| | 包内（会发 npm、过 DSH Store 安全门禁） | 包外（不发 npm） |
|---|---|---|
| 目录 | `lib/` `skills/` `test/` `scripts/` + 若干 md | `bench/` `security/` **`service/`** |
| 契约 | 零运行期依赖、**不联网**、**不起子进程**、无凭据 | 联网 / 要 API key / 起子进程 / 监听端口 |

`package.json` 的 `files` 白名单里**没有** `service/`（已核对），所以这一层不会进 npm 包，
也不参与插件契约。反过来，这里**只调用**包内脚本，不复制它们的逻辑：

| 端点 | 唯一实现来源 |
|---|---|
| `POST /lint` | `skills/fengge-wangming-tianya/scripts/fengge-lint.mjs` |
| `POST /align` | `skills/fengge-wangming-tianya/scripts/fengge-align.mjs` |
| `POST /retrieve` | `skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs` |
| `GET /metrics/summary` | 读 `bench/report/metrics-<runId>.json`（不起子进程） |

**为什么宁可多一层子进程也不内联算法**：`fengge-lint.mjs` 里 28 条规则/正则都是语料实测出来的，
一旦 Python 侧也抄一份，就会出现「脚本判 FAIL、接口判 PASS」这种最难查的分歧。
服务的职责只有三件：组参数、起子进程、把 JSON 原样透出。

---

## 2. 怎么起（Windows，实测命令）

### 2.1 建 venv（**不要**往 `C:\veighna_studio\python.exe` 装包）

那个解释器属于另一个产品，往里装 fastapi 会污染它。venv 用系统 Python 3.13 创建，
但依赖只落在 `service/.venv`：

```powershell
cd "C:\Users\ASUS\Documents\dsh Project\dsh-chact\fengge-distill\service"

# 1) 建 venv（用系统 Python 3.13 做种子，装包落在 .venv 里）
C:\veighna_studio\python.exe -m venv .venv

# 2) 装依赖（只有 fastapi / uvicorn / requests 三个直接依赖）
.\.venv\Scripts\python.exe -m pip install --no-cache-dir -r requirements.txt
```

装完实测（**本机真实输出**）：

```
Python 3.13.8
C:\Users\ASUS\Documents\dsh Project\dsh-chact\fengge-distill\service\.venv\Scripts\python.exe
base= C:\veighna_studio
prefix= ...\fengge-distill\service\.venv

fastapi 0.115.6
uvicorn 0.34.0
requests 2.32.3
pydantic 2.14.1

Successfully installed annotated-types-0.8.0 anyio-4.15.1 certifi-2026.7.22 charset-normalizer-3.5.2
click-8.5.0 fastapi-0.115.6 h11-0.16.0 idna-3.20 pydantic-2.14.1 pydantic-core-2.50.1
requests-2.32.3 starlette-0.41.3 typing-extensions-4.16.0 typing-inspection-0.4.4 urllib3-2.8.0 uvicorn-0.34.0
```

### 2.2 启动

```powershell
cd "C:\Users\ASUS\Documents\dsh Project\dsh-chact\fengge-distill\service"
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

自检价格算术（不需要起服务）：

```powershell
.\.venv\Scripts\python.exe app.py --selftest
```

冒烟测试（自己起服务、打完 6 组端点再收掉，见第 5 节）：

```powershell
.\.venv\Scripts\python.exe smoke.py
```

> **只监听 `127.0.0.1`。** 这个服务没有认证、没有限流、没有 TLS，请求体里可能带用户原始文案。
> 要暴露到局域网/公网，前面必须先加一层带鉴权的反向代理。

### 2.3 两个环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `FG_PRICING_PERIOD` | `auto` | 价格时段：`auto` 按 UTC 实时判定 / `peak` / `off_peak` 强制锁定。对账历史调用时用它复现"当时的时段"。 |
| `FG_NODE` | `node` | node 可执行文件路径（本机实测 `node v24.15.0`）。 |

---

## 3. 端点

| 方法 | 路径 | 入参 | 作用 |
|---|---|---|---|
| `GET` | `/health` | — | `{ok, version, model, pricing_source}` + 当前价格时段判定 |
| `POST` | `/lint` | `{text, form?}` | 调 `fengge-lint.mjs --file <tmp> --form <f> --json`，透出它的 JSON |
| `POST` | `/align` | `{texts:[...]}` | 调 `fengge-align.mjs --stdin --json`（每条文案 = 一个样本） |
| `POST` | `/retrieve` | `{query, k}` | 调 `fengge-retrieve.mjs --query <q> --k <k> --json` |
| `GET` | `/metrics/summary` | `?runId=` | 读 `bench/report/metrics-<runId>.json` |
| `GET` | `/cost` | — | 累计成本：今天 / 本周 / 总计 |
| `POST` | `/cost/estimate` | `{usage, period?}` | 按用量算这一笔的钱（含 peak/off-peak 对比） |

`form` 只接受 `short` / `long`；其它值返回 **422**（脚本自己会对未知 form 静默回落成 `short`，
那会让人误以为传了 `long` 生效了，所以在入口挡掉）。

`runId` 必须匹配 `^run-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$`——它会被拼进文件路径，
是本服务唯一的路径穿越面，所以先白名单再拼路径，拼完还断言结果落在 `bench/report/` 下。

---

## 4. 调用日志与成本

每个请求（含 4xx/5xx）写一行 JSONL 到 `service/logs/calls.jsonl`：

```json
{"ts":"2026-10-12T05:40:34.910+00:00","path":"/retrieve","method":"POST","query":{},
 "elapsedMs":240,"status":200,
 "requestDigest":{"query":"公司要求下班后微信待命","k":3},
 "usage":null,"pricingPeriod":null,"periodSelectedBy":null,"cost":null,"client":"127.0.0.1"}
```

- **时间戳 / 路径 / 耗时 ms / 响应码**：必填。
- **请求体摘要（截断）**：上限 160 字符，超出折叠成 `"…(共 N 字)"`——日志是对账用的，不是存全文的。
  唯一的例外是 `usage`，它**不截断**（截断就没法复算成本）。
- **token 用量与成本**：只在请求体里显式带 `usage` 时计算，否则 `null`。

### 4.1 价格从哪来

**全仓库唯一一份：`bench/pricing.json`。** 本服务读的就是它，`bench/` 侧的成本表（`bench/pricing.mjs`）读的也是它。
`/health`、`/cost` 的 `pricing_source.file` / `resolvedPath` / `sourceNote` 会把"实际读的是哪个文件"写出来。

> 这一节原本写的是"服务优先读自带的 `service/pricing.json`、缺失才回退 bench，`--selftest` 断言两份一致"。
> 那份副本**已被删除**，理由：两份副本 + 一道只在有人跑 `--selftest` 时才生效的闸门，**仍然是两个真相**；
> 分叉的后果是「bench 报表一个数、`/cost` 报另一个数」，这是最难查、最伤信任的一类 bug。
> 现在 `--selftest` 断言的是更强的东西：唯一来源必须是 `bench/pricing.json`、它必须真的被用上、
> 且 `service/` 下不得再存在第二份副本。

**价格数字不在这里复述**：只存在 `bench/pricing.json` 里，来源
`https://api-docs.deepseek.com/quick_start/pricing/`（2026-10-12 人工核对）。
模型 `deepseek-flash`（DeepSeek-V4.1-Flash），单位 USD / 百万 token。

### 4.2 时段判定（显式，不默认）

- peak = 周一至周五 UTC `01:00–04:00` 与 `06:00–10:00`，其余 off-peak；off-peak 各项恰为 peak 的一半。
- 代码按 UTC 实时判定，并把结果写进日志（`pricingPeriod` / `periodSelectedBy`）与每个响应。
- **`pricing.json` 里没有中国法定节假日日历**，所以节假日的 peak 窗口会被判成 **peak**
  （方向保守：只会高估成本，不会低估）。这是**已知偏差**，不是"已实现节假日"。

### 4.3 算钱规则

```
输入·缓存命中  × inputCacheHitPerMillion
输入·缓存未命中 × inputCacheMissPerMillion     # 上游不报 miss 时按 max(0, prompt_tokens - hit) 推算
输出           × outputPerMillion             # 只按 completion_tokens
```

- **输出侧一律按 `completion_tokens` 计，不再加 `reasoning_tokens`**：
  `deepseek-flash` 是推理模型，`reasoning_tokens` 本来就统计在 `completion_tokens` 里，
  单独再加就是重复计费。响应里用 `outputPricedOn: "completion_tokens"` 显式声明这一点。
- 缺字段一律标进 `missingFields`，不假装数据完整。

---

## 5. 证据（本机真跑，2026-10-12，UTC+8 下午）

### 5.1 起服务的命令与就绪

```
PS> cd "C:\Users\ASUS\Documents\dsh Project\dsh-chact\fengge-distill\service"
PS> .\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

另一条更省事的路径是冒烟脚本自己起（它的原话）：

```
· 解释器：...\fengge-distill\service\.venv\Scripts\python.exe
· 仓库根：...\fengge-distill
· 端口：8000（请求端口 8000）
· 已启动：...\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000（pid=15760）
· 服务就绪（2026-10-12T05:43:16+00:00）
```

### 5.2 自检（价格算术）

> 实测重跑于修好 UTF-8 stdio 之后（见第 7 节第 13 条）：**默认中文（GBK）控制台**直接跑就是 rc=0，
> 不需要预设 `PYTHONIOENCODING`。

```
PS> .\.venv\Scripts\python.exe app.py --selftest
  价格表 唯一来源：bench/pricing.json —— bench/pricing.json（全仓库唯一一份，bench 与 service 共用）
  脚本 ✓ skills\fengge-wangming-tianya\scripts\fengge-lint.mjs
  脚本 ✓ skills\fengge-wangming-tianya\scripts\fengge-align.mjs
  脚本 ✓ skills\fengge-wangming-tianya\scripts\fengge-retrieve.mjs
✓ --selftest 全部通过（deepseek-flash，peak 1.2 / off_peak 0.6 USD/M 输出）
selftest rc=0
```

`--selftest` 现在断言：唯一价格表路径 == `bench/pricing.json`、该文件存在、生效的就是它、
`service/` 下无第二份副本，以及官方的"off-peak 恰为 peak 一半"三条不变式。

### 5.3 真实 `curl` 返回

响应原文全部落在 `service/logs/evidence/`（curl 直接写文件，避免控制台代码页把事情搅浑）。

```powershell
$E="service\logs\evidence"
curl.exe -s -o "$E\health.json"   http://127.0.0.1:8000/health
curl.exe -s -o "$E\lint.json"     -X POST http://127.0.0.1:8000/lint     -H "Content-Type: application/json" --data-binary "@$E/req-lint.json"
curl.exe -s -o "$E\align.json"    -X POST http://127.0.0.1:8000/align    -H "Content-Type: application/json" --data-binary "@$E/req-align.json"
curl.exe -s -o "$E\retrieve.json" -X POST http://127.0.0.1:8000/retrieve -H "Content-Type: application/json" --data-binary "@$E/req-retrieve.json"
curl.exe -s -o "$E\metrics.json"  "http://127.0.0.1:8000/metrics/summary?runId=run-2026-10-12T05-25-39"
curl.exe -s -o "$E\cost.json"     http://127.0.0.1:8000/cost
curl.exe -s -o "$E\cost-estimate.json" -X POST http://127.0.0.1:8000/cost/estimate -H "Content-Type: application/json" --data-binary "@$E/req-cost.json"
```

HTTP 状态码（curl `-w "%{http_code}"`，原文见 `evidence/http-codes.txt`）：

```
health=200   lint=200   align=200   retrieve=200
metrics=200  cost_estimate=200  cost=200
traversal=400       missing_run=404    bad_form=422
```

**`GET /health`**（`evidence/health.json`，原文一行）：

```json
{"ok":true,"version":"0.1.0","model":"deepseek-flash",
 "pricing_source":{"file":"bench/pricing.json","resolvedPath":"...\\fengge-distill\\bench\\pricing.json",
   "sourceNote":"bench/pricing.json（全仓库唯一一份，bench 与 service 共用）",
   "url":"https://api-docs.deepseek.com/quick_start/pricing/","verifiedAt":"2026-10-12",
   "currency":"USD","unit":"USD_per_million_tokens"},
 "pricing_period":"off_peak",
 "pricing_period_selected_by":"UTC Mon 05:43 不在任何 peak 窗口（auto：按 UTC 实时判定）",
 "pricing_period_observed_utc":"2026-10-12T05:43:45+00:00","pricing_period_forced_by_env":false,
 "node":"node","repoRoot":"...\\fengge-distill"}
```

**`POST /lint`**（`evidence/lint.json`，节选）：请求文案
`你们天天上班我满仓，个人观点，点位看到4000，对吧？我算了算这账。`

```json
{"ok":true,"form":"short","fails":4,"warns":1,
 "report":{"len":34,"version":"2026","form":"short","results":[
   {"level":"FAIL","rule":"你们…我…对仗","msg":"命中：「你们天天上班我」"},
   {"level":"FAIL","rule":"直播语域","msg":"命中 对吧"},
   {"level":"FAIL","rule":"假口头禅","msg":"命中 我算了 / 这账"},
   {"level":"FAIL","rule":"免责句","msg":"出现但不在末句"},
   {"level":"WARN","rule":"结尾标点","msg":"以「。」收尾"}],
  "fails":4,"warns":1},
 "source":"skills/fengge-wangming-tianya/scripts/fengge-lint.mjs"}
```

> 关键点：脚本因 FAIL 而 `exit 1`，但 **HTTP 仍是 200**——那是正常的业务结果，不是服务故障。
> 而且 `report.len` 是 34，与服务收到的字符数一致，说明中文**没有**被编码改写。

**`POST /retrieve`**（`evidence/retrieve.json`，节选）：

```json
{"ok":true,"query":"公司要求下班后微信待命","k":3,"eligible":1511,"skipped":410,
 "corpus":"fg_fengge_v2_raw.json · sha256 5c9ea206b487… · 880 KiB · 来源 sibling",
 "hits":[{"score":18.7748,"text":"怀念那个曾经一天赚1000元，下班后去吃5串烤羊肉串，喝一瓶冰镇啤酒的我。…"},
         {"score":18.7748,"text":"怀念那个曾经一天赚2000元，…"},
         {"score":8.822,"text":"女家人征婚，夏夏，坐标杭州，93年，…"}]}
```

**`POST /align`**（`evidence/align.json`，节选）：3 条中文样本 →

```json
{"ok":true,"score":0.8666666666666667,"judged":30,"inBand":26,
 "report":{"n":3,"rows":[{"特征":"长度中位","语料":"41","允许带":"22–68","本批":"21","判定":"↓偏低"},…]}}
```

**`GET /metrics/summary`**（`evidence/metrics.json`，节选）：

```json
{"ok":true,"runId":"run-2026-10-12T05-25-39","file":"bench/report/metrics-run-2026-10-12T05-25-39.json",
 "metrics":{"at":"2026-10-12T05:33:08.672Z","runId":"run-2026-10-12T05-25-39",
   "conditions":{"c0-base":{"lint":{"failRate":0.2667},"band":{"rate":0.4}},"c1-distilled":{…},
                 "c2-retrieval":{…},"neg-formal":{…}},"control":{…}}}
```

**`POST /cost/estimate`**（`evidence/cost-estimate.json`，原文一行）：

```json
{"ok":true,"usage":{"prompt_tokens":1000000,"prompt_cache_hit_tokens":200000,
  "prompt_cache_miss_tokens":800000,"completion_tokens":100000,
  "completion_tokens_details":{"reasoning_tokens":90000}},
 "period":"off_peak","periodSelectedBy":"UTC Mon 05:43 不在任何 peak 窗口（auto：按 UTC 实时判定）",
 "observedUtc":"2026-10-12T05:43:46+00:00",
 "cost":{"currency":"USD","inputCacheHitTokens":200000,"inputCacheMissTokens":800000,
   "outputTokens":100000,"reasoningTokensReported":90000,"outputPricedOn":"completion_tokens",
   "unitPrices":{"inputCacheHitPerMillion":0.003,"inputCacheMissPerMillion":0.15,"outputPerMillion":0.6},
   "costUsd":{"inputCacheHit":0.0006,"inputCacheMiss":0.12,"output":0.06,"total":0.1806},
   "missingFields":[]},
 "compareBothPeriods":{"peak":0.3612,"off_peak":0.1806}}
```

手算对账：`0.2M/1M×0.003 + 0.8M/1M×0.15 + 0.1M/1M×0.60 = 0.0006 + 0.12 + 0.06 = 0.1806` ✓
（peak 恰为两倍 `0.3612`；`reasoning_tokens: 90000` **没有**被另外计一份钱。）

**`GET /cost`**（`evidence/cost.json`，节选）：

```json
{"ok":true,"currentPricingPeriod":"off_peak",
 "rates":{"peak":{…0.006/0.30/1.20},"off_peak":{…0.003/0.15/0.60}},
 "reportTimeZone":"UTC+8","malformedLogLines":0,
 "buckets":{"today":{"costUsd":0.7224,"calls":4},"week":{"costUsd":0.7224,"calls":4},
            "all":{"costUsd":0.7224,"calls":4}},
 "byEndpoint":{"/lint":{"calls":9,"costUsd":0.0,"callsWithUsage":0},
               "/retrieve":{"calls":4,"costUsd":0.0,"callsWithUsage":0},
               "/cost/estimate":{"calls":4,"costUsd":0.7224,"callsWithUsage":4}},
 "callsLogged":43,"callsWithUsage":4}
```

对账：`4 × 0.1806 = 0.7224` ✓。**本地 node 端点（lint/align/retrieve）的 `costUsd` 全是 0、
`callsWithUsage` 全是 0**——它们不产生 token，服务如实记为 `null` 而不是编一个数。

**错误路径**（`evidence/traversal.json` / `missing-run.json` / `bad-form.json`）：

```json
{"detail":{"error":"runId 格式非法","got":"../../../etc/passwd",
 "why":"runId 会被拼进文件路径，先挡掉路径穿越字符（/ \\ .. 等）"}}          → 400

{"detail":{"error":"没有这个 run 的指标文件","runId":"run-nope",
 "availableRunIds":["golden-batch","run-2026-10-12T05-25-39"]}}                → 404

{"detail":{"error":"form 只支持 short / long","got":"nope"}}                    → 422
```

### 5.4 调用日志的真实行

```json
{"ts":"2026-10-12T05:40:35.204+00:00","path":"/cost/estimate","method":"POST","elapsedMs":1,"status":200,
 "requestDigest":{"usage":{"prompt_tokens":1000000,"prompt_cache_hit_tokens":200000,
   "prompt_cache_miss_tokens":800000,"completion_tokens":100000},"period":"off_peak"},
 "usage":{…},"pricingPeriod":"off_peak","periodSelectedBy":"UTC Mon 05:40 不在任何 peak 窗口（auto：按 UTC 实时判定）",
 "cost":{"costUsd":{"inputCacheHit":0.0006,"inputCacheMiss":0.12,"output":0.06,"total":0.1806}},"client":"127.0.0.1"}
```

截断的实证（`evidence/log-samples.json`，第 4 条是 240 字长文）：

```json
{"path":"/lint","elapsedMs":177,"status":200,
 "requestDigest":{"text":"上班第一天，公司让我把工牌别在胸口，说这是规矩。…(共 240 字)","form":"long"}}
```

失败请求也进日志：

```json
{"path":"/metrics/summary","query":{"runId":"../../../etc/passwd"},"elapsedMs":0,"status":400}
```

### 5.5 冒烟测试：**49/49 通过**

```
PS> .\.venv\Scripts\python.exe smoke.py
...
[1] GET /health            ✓×9（含字段/model/pricing_source/显式时段）
[2] POST /lint             ✓×5（200、results 非空、检出 FAIL、字数往返一致、命中免责句）
[2b] form 非法             ✓ 422
[2c] 超长文案              ✓×2（240 字往返一致）
[3] POST /align            ✓×5（n=3、rows=30、中文字段名）
[4] POST /retrieve         ✓×4（query 回显、hits、eligible=1511）
[5] GET /metrics/summary   ✓×4（runId 一致、conditions、control）
[5b] 路径穿越 / 不存在      ✓×3（400 / 404 / 404 列出可用 runId）
[6] POST /cost/estimate    ✓×3（0.1806、0.3612、outputPricedOn）
[6b] GET /cost             ✓×6（三桶、读日志、只有 estimate 带 usage、本地调用全 null）
[7] calls.jsonl 逐行        ✓×5（12 行、必需字段齐、截断、耗时、非 200 也记）

========================================================================
冒烟测试：49/49 项通过
✓ 全部通过
========================================================================
smoke rc=0
```

`smoke.py` 起的是**真实 uvicorn + 真实 HTTP 端口**，不是 FastAPI `TestClient`：
TestClient 走 ASGI 内存调用，会绕过真实端口、真实编码边界、真实子进程，
而这三处恰好是这个服务最容易坏的地方。

---

## 6. Docker

### 6.1 本机探测结果：**daemon 没起，Docker 全程未验证**

```powershell
PS> docker info
Client:
 Context:    default
 Plugins:
  buildx: Docker Buildx (Docker Inc., v0.10.0)
  compose: Docker Compose (Docker Inc., v2.15.1)
Server:
ERROR: error during connect: This error may indicate that the docker daemon is not running.:
  Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/info": open //./pipe/docker_engine:
  The system cannot find the file specified.
exit=1

PS> docker version
Client: 20.10.22 (API 1.41), OS/Arch: windows/amd64
Server: (无法连接，同上)

PS> docker buildx ls
ERROR: docker endpoint for "default" not found
```

`docker compose version` → `Docker Compose version v2.15.1`（**客户端在，daemon 不在**）。
结论：**镜像没有 build 过，容器没有跑过**。下面的命令是**预期用法**，不是已验证过的结果。

### 6.2 准确的 build 命令

构建上下文必须是**仓库根**（服务要 exec `skills/` 里的脚本并读 `bench/report/`）：

```powershell
cd "C:\Users\ASUS\Documents\dsh Project\dsh-chact\fengge-distill"

# 单镜像
docker build -f service/Dockerfile -t fengge-distill-service:local .

# 或用 compose（compose 文件里 context 已经写成 ..）
docker compose -f service/docker-compose.yml up --build
curl.exe http://127.0.0.1:8000/health
```

`docker compose config` 在**不需要 daemon** 的情况下解析成功，确认 `context` 正确解析到仓库根：

```
name: service
services:
  fengge-service:
    build:
      context: C:\Users\ASUS\Documents\dsh Project\dsh-chact\fengge-distill
      dockerfile: service/Dockerfile
```

### 6.3 Dockerfile 说明

- 两段式：`builder` 装 pip 依赖到 `/opt/venv`，`runtime` 只拷 venv（不带编译工具链）。
- 基础镜像是 `node:24-bookworm-slim`（三个 `.mjs` 脚本要 node），`python3` 来自 debian 仓库。
  反过来在 `python:slim` 上装 node 24 要加 NodeSource 源，体积和不确定性都更大。
- `ENV PYTHONIOENCODING=utf-8 PYTHONUTF8=1`：把编码钉死，免得将来有人加一条走 locale 的路径踩到 mojibake。
- 非 root（uid 10001）运行；`HEALTHCHECK` 用 python 自带 `urllib`，不在镜像里多装 curl。

### 6.4 compose 说明（任务问到的"如果加 compose"）

- `context: ..` = 仓库根；`dockerfile: service/Dockerfile`。
- **语料卷**：`/retrieve` 依赖 `fg_fengge_v2_raw.json`，它是包外数据，按 `corpus-path.mjs` 的解析顺序
  位于仓库的**相邻目录**（`sibling`）。容器内 `REPO_ROOT=/app`，所以 sibling 是 `/fg_fengge_v2_raw.json`，
  compose 就挂到那里、只读。挂的是**具体文件**而不是目录——本机缺这个文件时 compose 会直接报错，
  不会静默建个目录让脚本抛 `EISDIR`。缺语料时 `/retrieve` 返回 **503** 并说明缺什么，其余端点不受影响。
- **日志卷**：`./logs:/app/service/logs`，容器重建也不丢账。

---

## 7. 未验证 / 已知偏差（**不编数字，这一节就是清单**）

**Docker 相关（全部未验证）**

1. **镜像没有 build 过**：`docker info` 显示 daemon 未运行（`//./pipe/docker_engine` 不存在），
   `docker buildx ls` 报 `docker endpoint for "default" not found`。所以 Dockerfile 与 compose
   只做了**静态**核对：`docker compose config` 能解析、构建上下文解析正确。
   **基础镜像能否拉下来、apt/pip 步骤能否走通、容器内 node+python 协作是否正常——都未验证。**
2. `service/.dockerignore` **目前不生效**：Docker 只认**构建上下文根目录**的 `.dockerignore`，
   而这个文件在 `service/` 下而上下文是仓库根。它放在那儿是给人照抄的模板。
   要真排除 `.venv/`、`service/logs/`（现在会把宿主机的 venv 打进镜像），
   需要把内容合并到仓库根的 `.dockerignore`——那超出「只动 `service/`」的边界，**没有替改**。
   建议仓库根加：`.venv/`、`service/.venv/`、`service/logs/`、`**/__pycache__/`。
3. 容器里 `HEALTHCHECK`、非 root 写 `logs/`、compose 的语料卷在宿主机缺文件时的报错形态，均未验证。

**能力 / 覆盖相关**

4. **peak 时段没有在真实 peak 窗口里跑过**：抓证据时 UTC 是周一下午 05:43（off-peak）。
   peak/off-peak 的判定与边界（`03:59`→peak、`04:00`→off-peak 右开区间、周六全天 off-peak）
   只在 `--selftest` 里用构造时间断言过，**没有**在真实时钟跨过窗口时观察过 `/cost` 的时段翻转。
5. **节假日未处理**（已知偏差）：`pricing.json` 没有中国法定节假日日历，节假日会被判成 peak，
   成本**偏高**。官方口径是节假日算 off-peak。要精确就得引入节假日日历，目前**故意没猜**。
6. **`/cost` 的成本从来没跟真实 LLM 调用对上过账**：本服务当前只做本地 node 透传，**不产生任何 token**，
   所有本地端点的 `usage` 恒为 `null`。目前非零的累计（0.7224）全部来自 `/cost/estimate`
   这次**显式喂了 usage** 的调用，用来验证算术与时段选择；**不是**真实账单。
   等 `bench/` 侧真的跑一次生成并把 usage 送进来，这个累计才有业务含义。
7. **中文命令行往返只在本机验证过**：`/retrieve` 故意用 `--query` 传中文（脚本没有 stdin 入口），
   实测中文经 argv 到 node 完整往返（`query` 原样回显、`/lint` 字数一致）。
   这依赖 `subprocess` 的 `encoding='utf-8'` 与 `PYTHONIOENCODING=utf-8`。
   `/lint` 走的是**临时文件**（脚本提供了 `--file`），那条路不受代码页影响。
   **换一台 locale 不同的机器、或换 node 版本（本机 v24.15.0）没有验证过。**
8. **并发 / 长跑未验证**：并发请求同时写 `calls.jsonl` 用的是 `O_APPEND` 单次 write，
   **没有**做多进程/高并发压测；`/cost` 每次请求全量读日志并在内存里聚合，
   日志到几十万行时的行为未测。没有 graceful shutdown、没有请求去重、没有缓存。
9. **没有认证/限流/TLS**：只监听 `127.0.0.1`。请求体摘要会进日志（截断到 160 字符），
   但**用户原始文案本身会被截断后落盘**——如果要处理敏感文本，先改这个策略。
10. **`/align` 的样本质量提示**：脚本自己在 `n < 20` 时会提示"结论不如 30+ 条稳"，
    服务原样透出该 JSON，没有额外拦截。冒烟测试只用 3 条样本，**不代表**任何统计结论。
11. **CI 未接入**：`smoke.py` 需要 node、语料（`/retrieve`）与 venv，还没加进 `.github/workflows/`。

**待办 / 已由主流程处理**

12. ~~两份价格表应合并成一份~~ **已处理**：`service/pricing.json` 已删除，唯一来源是 `bench/pricing.json`，
    入口代码 `PRICING_FILE` 只指向它，`--selftest` 会断言"生效的就是唯一那份、且 `service/` 下无副本"。
13. 仓库根 `.gitignore` / `.dockerignore` 需要加（**已由主流程补上**）：
    ```
    service/.venv/          # 依赖目录
    service/logs/           # 调用日志与证据
    service/__pycache__/    # 字节码
    service/pip-*           # pip 在 cwd 留下的临时目录（实测会出现，别提交）
    ```
14. **UTF-8 stdio 崩溃（已修）**：`app.py --selftest` 与 `smoke.py` 在**默认中文控制台**下直接
    `UnicodeEncodeError: 'gbk' codec can't encode character '\u2713'` 崩掉——它们全程打印 ✓/✗。
    `smoke.py` 更糟：它崩在第一句断言、**在清理之前**，于是 uvicorn 被留在后台占着端口。
    一个只在 `PYTHONIOENCODING=utf-8` 下才跑得通的冒烟测试等于没有冒烟测试。现在两个入口都会
    自行把 stdout/stderr 顶到 UTF-8（`errors="replace"` 兜底），实测默认 GBK 控制台下 rc=0。
    修之前 README 里"49/49 通过"这个数只在设了该环境变量时成立，**这里更正口径**。

---

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `service/app.py` | FastAPI 应用：6 个端点 + 调用日志 + 成本统计 + `--selftest` |
| `bench/pricing.json` | **唯一**价格表（用户核实的数字，不编价格）+ 来源 URL + 抓取日期。本服务读它，不另存副本 |
| `service/requirements.txt` | 三个直接依赖：fastapi / uvicorn / requests |
| `service/smoke.py` | 真跑冒烟测试：起 uvicorn、打 6 组端点、49 条断言 |
| `service/Dockerfile` | 镜像定义（上下文 = 仓库根） |
| `service/docker-compose.yml` | compose（语料只读卷 + 日志卷 + 健康检查） |
| `service/.dockerignore` | 模板；**要生效需合并到仓库根**（见 7-2） |
| `service/logs/calls.jsonl` | 运行期调用日志（一行一请求） |
| `service/logs/evidence/` | 第 5 节引用的 curl 原始响应与请求体 |
