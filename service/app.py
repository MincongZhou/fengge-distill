#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — 峰哥体「服务化」层（FastAPI）。

为什么它在 service/ 而不是 lib/：
    package.json 的 files 白名单是 lib / skills / test / scripts + 若干 md，**不含 service/**。
    包内对 DSH Store 承诺「零运行期依赖、不联网、不起子进程、无凭据」；这个服务恰好全都要
    （起 node 子进程、监听端口、将来要读 API 用量）。所以它必须待在包外，两边边界不能糊。

设计原则（硬约束，改代码前先读）：
  1. **零业务重实现**：lint / align / retrieve 的算法一个字都不在这里重抄。这里只做
     「组参数 → 起 node 子进程 → 把它的 JSON 原样透出」。
     仓库里已有单一实现来源：
       skills/fengge-wangming-tianya/scripts/fengge-lint.mjs
       skills/fengge-wangming-tianya/scripts/fengge-align.mjs
       skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs
     一旦这里也抄一份正则，就会出现「脚本判 A、接口判 B」，所以宁可在子进程边界上多花几毫秒。
  2. Windows 中文编码：node 的 stdout 一旦被接到管道，Python 在 Windows 上会按 **ANSI 代码页**
     去编码输出。中文文案走 stdout 就会变成 mojibake 甚至直接 UnicodeEncodeError。
     所以 env 里统一补 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1，subprocess 一律
     encoding='utf-8'，并且 lint 的中文**走临时文件**（--file）而不是命令行参数——
     命令行参数是最后一个不受 PYTHONIOENCODING 保护的入口。
  3. 价格不在这里硬编码：全部读 bench/pricing.json，并在调用时**显式判定**用的是
     peak 还是 off-peak（按 UTC 判断），把判定结果写进日志与响应，不默默挑一个。

启动（venv 见 README；不要往 C:\\veighna_studio\\python.exe 装包）：
    service\\.venv\\Scripts\\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000

自检价格算术：
    service\\.venv\\Scripts\\python.exe app.py --selftest
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------------------
# 路径与常量
# --------------------------------------------------------------------------------------

SERVICE_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVICE_DIR.parent

# 仓库里的单一实现来源（不要在本文件里复刻它们的算法）
SCRIPTS_DIR = REPO_ROOT / "skills" / "fengge-wangming-tianya" / "scripts"
LINT_MJS = SCRIPTS_DIR / "fengge-lint.mjs"
ALIGN_MJS = SCRIPTS_DIR / "fengge-align.mjs"
RETRIEVE_MJS = SCRIPTS_DIR / "fengge-retrieve.mjs"

BENCH_REPORT_DIR = REPO_ROOT / "bench" / "report"

# 价格表：**全仓库唯一一份**，在 bench/pricing.json。
#
# 这里曾经还有一份 service/pricing.json，代码写成"优先自己那份、缺失才回退 bench"。那种设计
# 连同它的"一致性闸门"一起被拆掉了：**两份副本 + 一道只在有人跑 --selftest 时才生效的闸门，
# 仍然是两个真相**。分叉的后果是「bench 报表一个数、/cost 报另一个数」，而这是最难查、
# 最伤信任的一类 bug——成本数字一旦不可信，整套评测的成本结论就都不可信。
# 所以现在只有一条路径，且 --selftest 会断言"生效的就是 bench 那份"。
PRICING_FILE = REPO_ROOT / "bench" / "pricing.json"
PRICING_CANDIDATES = (PRICING_FILE,)
LOG_DIR = SERVICE_DIR / "logs"
LOG_FILE = LOG_DIR / "calls.jsonl"

NODE_EXE = os.environ.get("FG_NODE", "node")

# 子进程超时：retrieve 要在本机把 880 KiB 语料建成 BM25 索引（实测 ~1s），给足余量。
TIMEOUT_LINT_S = 30
TIMEOUT_ALIGN_S = 60
TIMEOUT_RETRIEVE_S = 120

# 调用日志里「请求体摘要」的最大字符数。日志是用来对账的，不是用来存全文的。
REQUEST_DIGEST_CHARS = 160

# 「今天 / 本周」按 UTC+8 切分。为什么不是 UTC：这个服务的运维视角和成本对账都在中国，
# 用 UTC 切会把「凌晨 0–8 点」的开销算到前一天，和账单对不上。这是一个**显式选择**，
# 不是默认值——所以写在常量里并进 /health 暴露出来。
REPORT_TZ = timezone(timedelta(hours=8))
REPORT_TZ_NAME = "UTC+8"

# runId 白名单：只允许 [A-Za-z0-9._-]，并且必须含 "run-" 前缀。
# 为什么不用 pathlib 拼接了就算安全：/metrics/summary 的入参直接来自 URL，是**路径穿越**
# 的经典入口（../../etc/passwd）。这里在拼路径之前先用正则把非法字符挡掉。
RUN_ID_RE = re.compile(r"^run-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")

VERSION = "0.1.0"


# --------------------------------------------------------------------------------------
# 价格：读表 + 时段判定 + 算钱
# --------------------------------------------------------------------------------------


class PricingError(RuntimeError):
    """价格表缺字段/格式不对。宁可启动即失败，也不要拿默认价默默算错钱。"""


def load_pricing(path: Path | None = None) -> dict[str, Any]:
    """
    读价格表。path=None 时按 PRICING_CANDIDATES 的顺序解析，并把选了哪一份记下来。
    返回的 dict 里会多出 _resolvedPath / _resolvedSource 两个键，供 /health 与 /cost 透明上报。
    """
    if path is not None:
        candidates = (path,)
    else:
        candidates = PRICING_CANDIDATES

    chosen: Path | None = None
    for cand in candidates:
        if cand.exists():
            chosen = cand
            break
    if chosen is None:
        raise PricingError(
            "找不到价格表。试过：\n  " + "\n  ".join(str(c) for c in candidates)
            + "\n修法：价格表必须存在于 bench/pricing.json（全仓库唯一一份，bench 与 service 共用）。"
        )

    try:
        data = json.loads(chosen.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        # 半截 JSON（写入被打断）也会走到这里：报错要说清是哪个文件，不要让人猜
        raise PricingError(f"价格表不是合法 JSON：{chosen} -> {exc}") from exc

    for tier in ("peak", "off_peak"):
        block = data.get("rates", {}).get(tier)
        if not isinstance(block, dict):
            raise PricingError(f"价格表缺 rates.{tier}（{chosen}）")
        for field in (
            "inputCacheHitPerMillion",
            "inputCacheMissPerMillion",
            "outputPerMillion",
        ):
            if field not in block:
                raise PricingError(f"价格表缺 rates.{tier}.{field}（{chosen}）")

    # 解析结果是**显式**的：哪个文件进的数据，一路带到响应里，不让人猜
    data["_resolvedPath"] = str(chosen)
    data["_resolvedFile"] = f"{chosen.parent.name}/{chosen.name}"
    data["_resolvedSource"] = (
        "bench/pricing.json（全仓库唯一一份，bench 与 service 共用）"
        if chosen == PRICING_FILE
        else f"非预期路径：{chosen}（应为 {PRICING_FILE}）"
    )
    return data


def _is_valid_json(path: Path) -> bool:
    """先探一次能否解析：给调用方一个"这文件能不能读"的快速判断，不在这里抛异常。"""
    try:
        json.loads(path.read_text(encoding="utf-8"))
        return True
    except (OSError, json.JSONDecodeError):
        return False


PRICING = load_pricing()

MODEL_ID = PRICING["model"]["id"]
PRICING_SOURCE_URL = PRICING["source"]["url"]
PRICING_VERIFIED_AT = PRICING["source"]["verifiedAt"]


def _parse_hhmm(s: str) -> tuple[int, int]:
    hh, mm = s.split(":")
    return int(hh), int(mm)


PEAK_WINDOWS = [
    (_parse_hhmm(w["from"]), _parse_hhmm(w["to"])) for w in PRICING["model"]["peakWindowsUtc"]
]


def is_peak_utc(dt: datetime) -> tuple[bool, str]:
    """
    按 UTC 判断是否落在 peak 时段。返回 (是否 peak, 人读原因)。

    为什么要把 holiday 单独说清楚：官方口径里 peak 时段**不含中国法定节假日**，
    但 pricing.json 里没有节假日日历，本实现**故意不猜**——所以节假日会被判成 peak。
    方向是保守的（只会高估成本，不会低估），并在返回值里留痕，方便对账时发现偏差。
    """
    dt = dt.astimezone(timezone.utc)
    # weekday(): 周一=0 … 周日=6。官方是「周一至周五」，所以 5/6（周六/周日）直接 off-peak。
    weekday_ok = dt.weekday() <= 4
    if not weekday_ok:
        return False, f"UTC {dt.strftime('%a %H:%M')} 属周末，全天 off-peak"

    minutes = dt.hour * 60 + dt.minute
    for (fh, fm), (th, tm) in PEAK_WINDOWS:
        if fh * 60 + fm <= minutes < th * 60 + tm:
            return True, f"UTC {dt.strftime('%a %H:%M')} 落在 peak 窗口 {fh:02d}:{fm:02d}–{th:02d}:{tm:02d}"
    return False, f"UTC {dt.strftime('%a %H:%M')} 不在任何 peak 窗口"


def resolve_period(now: datetime | None = None) -> dict[str, Any]:
    """
    显式声明这次调用用哪个时段的价格。

    默认 auto（按 UTC 实时判定）；可以用环境变量 FG_PRICING_PERIOD 强制锁定：
      FG_PRICING_PERIOD=peak / off_peak / auto
    为什么要留强制口：对账时要能用**当时的时段**重算历史调用，而不是用"现在"的时段。
    """
    forced = os.environ.get("FG_PRICING_PERIOD", "auto").strip()
    now = now or datetime.now(timezone.utc)
    if forced in ("peak", "off_peak"):
        return {
            "period": forced,
            "selected_by": f"env:FG_PRICING_PERIOD={forced}（强制锁定，未按 UTC 判断）",
            "observed_utc": now.astimezone(timezone.utc).isoformat(timespec="seconds"),
            "auto_period": ("peak" if is_peak_utc(now)[0] else "off_peak"),
            "rates": PRICING["rates"][forced],
        }
    if forced not in ("auto", ""):
        raise PricingError(f"FG_PRICING_PERIOD 取值非法：{forced!r}（可选 auto/peak/off_peak）")

    peak, why = is_peak_utc(now)
    chosen = "peak" if peak else "off_peak"
    return {
        "period": chosen,
        "selected_by": why + "（auto：按 UTC 实时判定）",
        "observed_utc": now.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "auto_period": chosen,
        "rates": PRICING["rates"][chosen],
    }


def usage_cost_usd(usage: dict[str, Any], rates: dict[str, Any]) -> dict[str, Any]:
    """
    按 usage 算这一笔的钱（USD）。

    字段名对齐 DeepSeek /chat/completions 的 usage（见 bench/lib/deepseek.mjs）：
      prompt_tokens              = 输入总 token
      prompt_cache_hit_tokens    = 输入里命中缓存的部分
      prompt_cache_miss_tokens   = 输入里未命中缓存的部分（上游不给时用 prompt_tokens - hit 推）
      completion_tokens          = 输出总量，**已包含 reasoning_tokens**

    三个刻意的决定，都是「不编数字」：
      · 输出侧一律按 completion_tokens 计，**不再加 reasoning_tokens**——
        reasoning 本来就统计在 completion_tokens 里，单独再加就是重复计费。
      · cache miss **不用 0 兜底**：上游不报 miss 时，用 max(0, prompt - hit) 推；
        这样单个 usage 行的结果与整批求和的结果不会因为兜底值不同而打架。
      · 缺 prompt_tokens / completion_tokens 时按 0 处理但把 missing 标出来，
        不假装数据完整。
    """
    missing: list[str] = []
    prompt = usage.get("prompt_tokens")
    hit = usage.get("prompt_cache_hit_tokens")
    miss = usage.get("prompt_cache_miss_tokens")
    completion = usage.get("completion_tokens")

    if prompt is None:
        missing.append("prompt_tokens")
    if hit is None:
        missing.append("prompt_cache_hit_tokens")
    if completion is None:
        missing.append("completion_tokens")

    prompt_i = int(prompt or 0)
    hit_i = int(hit or 0)
    completion_i = int(completion or 0)
    if miss is None:
        # 上游没给 miss 就推出来，并在 missing 里说明是推的
        miss_i = max(0, prompt_i - hit_i)
        missing.append("prompt_cache_miss_tokens(按 prompt-hit 推算)")
    else:
        miss_i = int(miss)

    d = Decimal
    unit = d(1_000_000)
    cache_cost = d(hit_i) / unit * d(str(rates["inputCacheHitPerMillion"]))
    miss_cost = d(miss_i) / unit * d(str(rates["inputCacheMissPerMillion"]))
    out_cost = d(completion_i) / unit * d(str(rates["outputPerMillion"]))
    total = cache_cost + miss_cost + out_cost

    return {
        "currency": PRICING.get("currency", "USD"),
        "inputCacheHitTokens": hit_i,
        "inputCacheMissTokens": miss_i,
        "outputTokens": completion_i,
        # reasoning_tokens 只在有上报时回显，**不参与计价**（它已含在 outputTokens 里）
        "reasoningTokensReported": usage.get("completion_tokens_details", {}).get("reasoning_tokens")
        if isinstance(usage.get("completion_tokens_details"), dict)
        else usage.get("reasoning_tokens"),
        "outputPricedOn": "completion_tokens",
        "unitPrices": {
            "inputCacheHitPerMillion": rates["inputCacheHitPerMillion"],
            "inputCacheMissPerMillion": rates["inputCacheMissPerMillion"],
            "outputPerMillion": rates["outputPerMillion"],
        },
        "costUsd": {
            "inputCacheHit": float(round(cache_cost, 8)),
            "inputCacheMiss": float(round(miss_cost, 8)),
            "output": float(round(out_cost, 8)),
            "total": float(round(total, 8)),
        },
        "missingFields": missing,
        "note": f"输出侧按 completion_tokens 计（已含 reasoning_tokens，不重复计）；价格来自 {PRICING.get('_resolvedFile')}。",
    }


# --------------------------------------------------------------------------------------
# 调 node：唯一的对外实现来源
# --------------------------------------------------------------------------------------


def node_env() -> dict[str, str]:
    """
    给子进程准备环境变量。

    PYTHONIOENCODING / PYTHONUTF8 是给 node 里可能存在的 python 子调用兜底的；
    真正关键的是：node 的 stdout 被接进管道时，Windows 上任何「按 locale 编码」的环节
    都会把中文写成 mojibake。把这两个变量钉成 utf-8，再配合 subprocess 侧 encoding='utf-8'，
    中文才能原样往返。这条在 README 的「证据」一节里有真跑验证。
    """
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def run_node(script: Path, args: list[str], *, stdin_text: str | None = None, timeout: int = 30) -> dict[str, Any]:
    """
    跑一个仓库内脚本并把它的 JSON 透出来。返回：
      {ok, rc, json, stdout_head, stderr_head, error}

    为什么返回结构而不是抛异常：调用方要把它包成 HTTP 响应，需要区分
    「脚本崩了」「脚本没输出 JSON」「脚本正常但有 FAIL（exit 1）」这三种情况——
    lint 有 FAIL 时退出码就是 1，那是**正常的业务结果**，不是服务故障。
    """
    if not script.exists():
        return {"ok": False, "rc": None, "json": None, "stdout_head": "", "stderr_head": "",
                "error": f"找不到脚本：{script}（是否在包外运行、或仓库结构变了？）"}

    try:
        proc = subprocess.run(
            [NODE_EXE, str(script), *args],
            input=stdin_text,
            capture_output=True,
            text=True,
            encoding="utf-8",       # 不用默认编码：Windows 默认是 ANSI，中文必坏
            errors="replace",        # 宁可留 U+FFFD 也不要因为一个坏字节把整个请求打成 500
            timeout=timeout,
            cwd=str(REPO_ROOT),      # 让脚本的相对路径（data/、bench/）按仓库根解析
            env=node_env(),
        )
    except FileNotFoundError as exc:
        return {"ok": False, "rc": None, "json": None, "stdout_head": "", "stderr_head": "",
                "error": f"起不了 node（{NODE_EXE}）：{exc}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "rc": None, "json": None, "stdout_head": "", "stderr_head": "",
                "error": f"脚本超时（{timeout}s）：{script.name}"}

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    parsed: Any = None
    parse_error = None
    stripped = stdout.strip()
    if stripped:
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError as exc:
            parse_error = f"stdout 不是合法 JSON：{exc}"

    ok = proc.returncode == 0 and parsed is not None
    error = None
    if proc.returncode != 0:
        # lint 有 FAIL → exit 1，但 stdout 里是完整 JSON；这种情况算 ok，仍按 200 透出。
        if parsed is not None:
            ok = True
        else:
            error = f"{script.name} 退出码 {proc.returncode}；stderr: {stderr.strip()[:400] or '(空)'}"
    elif parse_error:
        error = parse_error

    return {
        "ok": ok,
        "rc": proc.returncode,
        "json": parsed,
        "stdout_head": stdout[:400],
        "stderr_head": stderr[:400],
        "error": error,
    }


# --------------------------------------------------------------------------------------
# 调用日志（JSONL）+ 成本归集
# --------------------------------------------------------------------------------------


def summarize_request_body(body: Any, limit: int = REQUEST_DIGEST_CHARS) -> Any:
    """
    请求体摘要：**截断**后入日志。

    为什么截断：一段 3000 字文案乘以每次调用会让日志迅速膨胀，而且日志的用途是
    「对账 token/成本 + 排查谁调了什么」，不是存档全文。长文本一律折叠成
    {'_truncated': True, 'chars': N, 'head': '...'}，保留长度信息（长度本身是业务信号）。
    """
    def clip(s: str) -> str:
        return s if len(s) <= limit else s[:limit] + f"…(共 {len(s)} 字)"

    if body is None:
        return None
    if isinstance(body, str):
        return clip(body)
    if isinstance(body, dict):
        out: dict[str, Any] = {}
        for k, v in body.items():
            if k == "usage":
                # usage 是账目数据，不截断——截断会让成本无法复算
                out[k] = v
            elif isinstance(v, str):
                out[k] = clip(v)
            elif isinstance(v, list):
                out[k] = {
                    "_list": True,
                    "count": len(v),
                    "first": clip(str(v[0])) if v else None,
                }
            else:
                out[k] = v
        return out
    return clip(str(body))


def append_log(entry: dict[str, Any]) -> None:
    """
    追加一行 JSONL。**同步写**：这是对账数据，宁可让请求多花 0.1ms，也不要丢账。
    并发下用 O_APPEND 单次 write，避免多进程交错把行写坏。
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with open(LOG_FILE, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(line)


def read_log_rows() -> tuple[list[dict[str, Any]], int]:
    """读全部日志行。返回 (合法行, 坏行数)——坏行不静默吞掉，计数上报。"""
    if not LOG_FILE.exists():
        return [], 0
    rows: list[dict[str, Any]] = []
    bad = 0
    with open(LOG_FILE, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    return rows, bad


def _report_window(now: datetime) -> tuple[datetime, datetime, datetime]:
    """返回 (今天 0 点, 本周一 0 点, now)，全部在 REPORT_TZ（UTC+8）。"""
    local = now.astimezone(REPORT_TZ)
    today0 = local.replace(hour=0, minute=0, second=0, microsecond=0)
    week0 = today0 - timedelta(days=today0.weekday())  # 周一为一周之始
    return today0, week0, local


def _parse_ts(s: Any) -> datetime | None:
    """日志里的 ts 是 ISO8601（带时区）。解析不了就返回 None，绝不用 now 冒充。"""
    if not isinstance(s, str) or not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def compute_usage_cost(usage: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """算钱并附上**时段判定**。时段是显式结果，跟着钱一起返回。"""
    period = resolve_period(now)
    cost = usage_cost_usd(usage, period["rates"])
    return {
        "period": period["period"],
        "periodSelectedBy": period["selected_by"],
        "observedUtc": period["observed_utc"],
        "cost": cost,
    }


def aggregate_costs(rows: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    """
    把日志按「今天 / 本周 / 总计」归集。

    两个诚实性约束：
      · 只有带 usage 的行才计入成本；没有 usage 的行为 null，而不是 0——
        0 会被读成「这次调用不要钱」，null 才是「这次调用没有 token 信息」。
      · 每一行用**它自己当时记录的时段**重算（日志里存了 period），
        所以历史行不会因为现在处于 peak 而变贵。
    """
    now = now or datetime.now(timezone.utc)
    today0, week0, _ = _report_window(now)

    empty = lambda: {"costUsd": 0.0, "calls": 0}  # noqa: E731
    buckets = {"today": empty(), "week": empty(), "all": empty()}
    by_endpoint: dict[str, dict[str, Any]] = {}
    periods_seen: dict[str, int] = {}
    usage_bearing = 0

    def bump(bucket: dict[str, Any], total: float) -> None:
        bucket["costUsd"] = round(bucket["costUsd"] + total, 8)
        bucket["calls"] += 1

    for row in rows:
        usage = row.get("usage")
        total: float | None = None
        if isinstance(usage, dict) and any(
            usage.get(k) is not None
            for k in ("prompt_tokens", "prompt_cache_hit_tokens", "completion_tokens")
        ):
            period = row.get("pricingPeriod")
            # 用调用当时记录的时段重算；日志缺该字段时才退回"现在"
            rates = PRICING["rates"].get(period) if period in ("peak", "off_peak") else None
            if rates is None:
                rates = resolve_period(now)["rates"]
                period = resolve_period(now)["period"]
            total = usage_cost_usd(usage, rates)["costUsd"]["total"]
            usage_bearing += 1
            periods_seen[str(period)] = periods_seen.get(str(period), 0) + 1

        ts = _parse_ts(row.get("ts"))
        local_ts = ts.astimezone(REPORT_TZ) if ts else None
        path = str(row.get("path") or "unknown")
        ep = by_endpoint.setdefault(path, {"calls": 0, "costUsd": 0.0, "callsWithUsage": 0})
        ep["calls"] += 1

        if total is None:
            continue
        bump(buckets["all"], total)
        if local_ts is not None:
            if local_ts >= week0:
                bump(buckets["week"], total)
            if local_ts >= today0:
                bump(buckets["today"], total)
        ep["costUsd"] = round(ep["costUsd"] + total, 8)
        ep["callsWithUsage"] += 1

    return {
        "reportTimeZone": REPORT_TZ_NAME,
        "windowStartToday": today0.isoformat(timespec="seconds"),
        "windowStartWeek": week0.isoformat(timespec="seconds"),
        "buckets": buckets,
        "byEndpoint": by_endpoint,
        "periodsSeen": periods_seen,
        "callsLogged": len(rows),
        "callsWithUsage": usage_bearing,
        "note": (
            "只有带 usage 的调用计入成本；callsWithUsage 会说明有多少笔真的带 usage。"
            "本地 node 工具（lint/align/retrieve）不产生 token，它们的行 usage 恒为 null、"
            "不会进成本；callsWithUsage 里出现的笔数只可能来自显式带了 usage 的请求（如 /cost/estimate）。"
            "详见 README「边界」一节。"
        ),
    }


# --------------------------------------------------------------------------------------
# /metrics/summary 的 runId 解析
# --------------------------------------------------------------------------------------


def resolve_metrics_file(run_id: str) -> Path:
    """
    runId → bench/report/metrics-<runId>.json。

    先做正则白名单再拼路径：这个入参直接来自 URL 查询串，是本服务唯一的路径穿越面。
    白名单只放 [A-Za-z0-9._-] 且必须 run- 开头，`..` 里的点虽然合法但连不成 `../`
    （`/` 和 `\\` 都进不来），所以穿越不成立。拼完再断言一层：结果必须在 bench/report 下。
    """
    if not RUN_ID_RE.match(run_id or ""):
        raise HTTPException(
            status_code=400,
            detail={
                "error": "runId 格式非法",
                "got": run_id,
                "expect": "run-[A-Za-z0-9._-]，例如 run-2026-10-12T05-25-39",
                "why": "runId 会被拼进文件路径，先挡掉路径穿越字符（/ \\ .. 等）",
            },
        )
    candidate = (BENCH_REPORT_DIR / f"metrics-{run_id}.json").resolve()
    report_root = BENCH_REPORT_DIR.resolve()
    if report_root not in candidate.parents:
        raise HTTPException(status_code=400, detail={"error": "解析出的路径越出了 bench/report", "resolved": str(candidate)})
    if not candidate.exists():
        available: list[str] = []
        if report_root.exists():
            available = sorted(p.stem.replace("metrics-", "", 1) for p in report_root.glob("metrics-*.json"))
        raise HTTPException(
            status_code=404,
            detail={"error": "没有这个 run 的指标文件", "runId": run_id, "lookedFor": str(candidate), "availableRunIds": available},
        )
    return candidate


# --------------------------------------------------------------------------------------
# 请求体模型
# --------------------------------------------------------------------------------------


class LintRequest(BaseModel):
    text: str = Field(..., description="待自检的文案")
    form: str = Field("short", description="形态：short（原创短帖）/ long（长微博）")


class AlignRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, description="一批文案，逐条作为一个样本")


class RetrieveRequest(BaseModel):
    query: str = Field(..., min_length=1, description="查询文案")
    k: int = Field(5, ge=1, le=50, description="返回条数")


class CostEstimateRequest(BaseModel):
    """
    usage 字段名与 DeepSeek /chat/completions 的 usage 对齐（见 bench/lib/deepseek.mjs）：
    prompt_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens / completion_tokens。
    允许额外字段（reasoning_tokens 之类），只是不参与计价。
    """
    usage: dict[str, Any] = Field(..., description="token 用量")
    period: str | None = Field(None, description="强制指定时段 peak / off_peak；不给则按 UTC 判定")


# --------------------------------------------------------------------------------------
# FastAPI
# --------------------------------------------------------------------------------------

app = FastAPI(
    title="fengge-distill service",
    version=VERSION,
    description=(
        "峰哥体蒸馏引擎的服务化包装层（在包外，不参与 npm/DSH Store 插件契约）。"
        "本服务不重新实现任何算法：lint/align/retrieve 全部转调 skills/ 下已有的 node 脚本。"
    ),
)


@app.middleware("http")
async def call_log_middleware(request: Request, call_next):
    """
    每个请求写一行 JSONL。

    为什么做成中间件而不是在每个 handler 里各写一遍：
      日志要覆盖**所有**请求，包括 400/404/422 和未捕获异常。写在 handler 里一定会漏。
    中间件拿不到 handler 里算好的 "透出的 JSON"，但日志只需要**响应码 + 请求摘要 + 成本**，
    这些在这里都能拿到；成本靠请求体里显式携带的 usage（见 README 边界说明）。
    """
    started = datetime.now(timezone.utc)
    body_obj: Any = None
    if request.method in ("POST", "PUT", "PATCH"):
        raw = await request.body()
        if raw:
            try:
                body_obj = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                body_obj = raw.decode("utf-8", errors="replace")

    status_code = 500
    response = None
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        elapsed_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        usage = body_obj.get("usage") if isinstance(body_obj, dict) else None
        cost_block = None
        if isinstance(usage, dict):
            try:
                cost_block = compute_usage_cost(usage, now=started)
            except Exception as exc:  # 算钱失败绝不能把请求也带崩
                cost_block = {"error": f"成本计算失败：{exc}"}

        entry = {
            "ts": started.isoformat(timespec="milliseconds"),
            "path": request.url.path,
            "method": request.method,
            "query": dict(request.query_params),
            "elapsedMs": elapsed_ms,
            "status": status_code,
            "requestDigest": summarize_request_body(body_obj),
            "usage": usage if isinstance(usage, dict) else None,
            "pricingPeriod": (cost_block or {}).get("period"),
            "periodSelectedBy": (cost_block or {}).get("periodSelectedBy"),
            "cost": (cost_block or {}).get("cost"),
            "client": request.client.host if request.client else None,
        }
        try:
            append_log(entry)
        except Exception as exc:  # 磁盘满/权限问题：日志失败不阻断业务
            print(f"[warn] 写调用日志失败：{exc}", file=sys.stderr)


# ---------------------------- 端点 ----------------------------


@app.get("/health")
async def health():
    """GET /health → {ok, version, model, pricing_source}（外加时段判定，不藏事）"""
    period = resolve_period()
    return {
        "ok": True,
        "version": VERSION,
        "model": MODEL_ID,
        "pricing_source": {
            # 显式上报读的是哪一份、是不是回退——不让人以为"价格来自某个猜出来的文件"
            "file": PRICING.get("_resolvedFile"),
            "resolvedPath": PRICING.get("_resolvedPath"),
            "sourceNote": PRICING.get("_resolvedSource"),
            "url": PRICING_SOURCE_URL,
            "verifiedAt": PRICING_VERIFIED_AT,
            "currency": PRICING.get("currency", "USD"),
            "unit": PRICING["model"]["unit"],
        },
        # 显式声明此刻用哪个时段，不默默选一个
        "pricing_period": period["period"],
        "pricing_period_selected_by": period["selected_by"],
        "pricing_period_observed_utc": period["observed_utc"],
        "pricing_period_forced_by_env": os.environ.get("FG_PRICING_PERIOD", "auto") != "auto",
        "node": NODE_EXE,
        "repoRoot": str(REPO_ROOT),
    }


@app.post("/lint")
async def lint(req: LintRequest):
    """
    POST /lint {text, form?} → 透出 fengge-lint.mjs --json 的完整 JSON。

    form 先在**本服务**用枚举挡掉非法值：脚本自己会对未知 form 静默回落成 LEN.short，
    那会让人以为传了 long 生效了。宁可在入口报 422。
    """
    if req.form not in ("short", "long"):
        raise HTTPException(status_code=422, detail={"error": "form 只支持 short / long", "got": req.form})

    # 中文走临时文件而不是命令行参数：命令行是最后一个不受 PYTHONIOENCODING 保护的入口，
    # 零字节（\u200b）、代理对、emoji 都可能在某些代码页下被改写。临时文件只有 utf-8 一条路。
    tmp_name = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8", newline="") as fh:
            fh.write(req.text)
            tmp_name = fh.name
        result = run_node(
            LINT_MJS,
            ["--file", tmp_name, "--form", req.form, "--json"],
            timeout=TIMEOUT_LINT_S,
        )
    finally:
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass  # 临时文件残留不影响正确性（系统会清 temp），不要因此把请求打成 500

    if not result["ok"]:
        raise HTTPException(
            status_code=502,
            detail={"error": "fengge-lint.mjs 调用失败", "detail": result["error"], "rc": result["rc"], "stderr": result["stderr_head"]},
        )
    payload = result["json"]
    return {
        "ok": True,
        "form": req.form,
        "fails": payload.get("fails"),
        "warns": payload.get("warns"),
        "report": payload,          # 脚本的原始 JSON，一字不改
        "source": "skills/fengge-wangming-tianya/scripts/fengge-lint.mjs",
    }


@app.post("/align")
async def align(req: AlignRequest):
    """
    POST /align {texts:[...]} → fengge-align.mjs --stdin --json。

    走 stdin：脚本本来就读 stdin 并按行切分，所以**多行文案天然就是多个样本**，
    不需要中间层做任何拼接或转义——少一层就少一个出错的地方。
    """
    if not req.texts:
        raise HTTPException(status_code=422, detail={"error": "texts 不能为空"})
    empty = [i for i, t in enumerate(req.texts) if not str(t).strip()]
    if empty:
        # 脚本会把空行 filter 掉，于是"传了 5 条"变成"样本 4 条"，对不上账。
        # 与其让人事后纳闷，不如在入口直接说清楚是哪几条是空的。
        raise HTTPException(
            status_code=422,
            detail={"error": "texts 里有空白样本，脚本会静默丢弃、导致样本数与传入不符", "emptyIndexes": empty},
        )
    stdin_text = "\n".join(str(t) for t in req.texts)
    result = run_node(ALIGN_MJS, ["--stdin", "--json"], stdin_text=stdin_text, timeout=TIMEOUT_ALIGN_S)
    if not result["ok"]:
        detail = result["error"] or ""
        # 缺 data/style-ratios.json 时脚本报错并 exit 2——这是环境问题，不是请求问题
        status = 503 if "style-ratios" in detail else 502
        raise HTTPException(status_code=status, detail={"error": "fengge-align.mjs 调用失败", "detail": detail, "rc": result["rc"], "stderr": result["stderr_head"]})
    payload = result["json"]
    return {
        "ok": True,
        "score": payload.get("score"),
        "judged": payload.get("judged"),
        "inBand": payload.get("inBand"),
        "report": payload,
        "source": "skills/fengge-wangming-tianya/scripts/fengge-align.mjs",
    }


@app.post("/retrieve")
async def retrieve(req: RetrieveRequest):
    """
    POST /retrieve {query, k} → fengge-retrieve.mjs --query <q> --k <k> --json。

    这里**故意**用命令行参数：实测（见 README 证据）中文经 argv 到 node 是完整往返的，
    而脚本只认 --query（没有 stdin 入口）。lint 那条走临时文件是因为脚本提供了 --file ——
    能用文件就优先用文件，那条路才不受代码页影响。
    语料找不到（脚本报 CorpusNotFound / exit 1）时返回 503 并把「试过哪些路径」透出来，
    不静默返回空结果——空 hits 会被误读成"语料里真没有相似的句式"。
    """
    result = run_node(
        RETRIEVE_MJS,
        ["--query", req.query, "--k", str(req.k), "--json"],
        timeout=TIMEOUT_RETRIEVE_S,
    )
    if not result["ok"]:
        detail = result["error"] or ""
        status = 503 if ("语料" in detail or "Corpus" in detail) else 502
        raise HTTPException(
            status_code=status,
            detail={
                "error": "fengge-retrieve.mjs 调用失败",
                "detail": detail,
                "stderr": result["stderr_head"],
                "hint": "语料不在仓库内：需把 fg_fengge_v2_raw.json 放到仓库相邻目录，或用 FG_CORPUS=<path> 指定",
            },
        )
    payload = result["json"]
    return {
        "ok": True,
        "query": payload.get("query"),
        "k": payload.get("k"),
        "eligible": payload.get("eligible"),
        "skipped": payload.get("skipped"),
        "corpus": payload.get("corpus"),
        "hits": payload.get("hits"),
        "report": payload,
        "source": "skills/fengge-wangming-tianya/scripts/fengge-retrieve.mjs",
    }


@app.get("/metrics/summary")
async def metrics_summary(runId: str):
    """GET /metrics/summary?runId=... → 读 bench/report/metrics-<runId>.json 原样返回。"""
    path = resolve_metrics_file(runId)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail={"error": "指标文件读取/解析失败", "path": str(path), "detail": str(exc)})
    return {
        "ok": True,
        "runId": runId,
        "file": f"bench/report/metrics-{runId}.json",
        "metrics": payload,
    }


@app.get("/cost")
async def cost():
    """
    GET /cost → 累计成本（今天 / 本周 / 总计）。
    每一行用**它当时记录的时段**重算；没有 usage 的行不计入，并在 callsWithUsage 里留痕。
    """
    rows, bad_lines = read_log_rows()
    if bad_lines:
        print(f"[warn] 调用日志里有 {bad_lines} 行坏 JSON（已跳过，不中断统计）", file=sys.stderr)
    agg = aggregate_costs(rows)
    period = resolve_period()
    return {
        "ok": True,
        "model": MODEL_ID,
        "pricing_source": {
            "file": PRICING.get("_resolvedFile"),
            "resolvedPath": PRICING.get("_resolvedPath"),
            "sourceNote": PRICING.get("_resolvedSource"),
            "url": PRICING_SOURCE_URL,
            "verifiedAt": PRICING_VERIFIED_AT,
        },
        "currentPricingPeriod": period["period"],
        "currentPricingPeriodSelectedBy": period["selected_by"],
        "rates": {k: v for k, v in PRICING["rates"].items()},
        "logFile": "service/logs/calls.jsonl",
        "malformedLogLines": bad_lines,
        **agg,
    }


@app.post("/cost/estimate")
async def cost_estimate(req: CostEstimateRequest):
    """
    POST /cost/estimate {usage:{...}, period?} → 这一笔的价钱。

    为什么留这个端点：/cost 的累计要靠真实 LLM 调用的 usage，而本服务当前只做本地
    node 透传、根本不产生 token（见 README 边界）。为了让「算钱」这条路径**可验证**，
    这里提供纯函数式的估价入口：给 usage 直接返回分项与合计，同时暴露 peak/off_peak 两档，
    便于人工对账时分清"贵是因为用量"还是"贵是因为时段"。
    """
    if req.period is not None and req.period not in ("peak", "off_peak"):
        raise HTTPException(status_code=422, detail={"error": "period 只支持 peak / off_peak", "got": req.period})
    now = datetime.now(timezone.utc)
    if req.period:
        rates = PRICING["rates"][req.period]
        chosen = {"period": req.period, "selected_by": f"请求显式指定 period={req.period}", "observed_utc": now.isoformat(timespec="seconds")}
    else:
        chosen = resolve_period(now)
        rates = chosen["rates"]
    return {
        "ok": True,
        "usage": req.usage,
        "period": chosen["period"],
        "periodSelectedBy": chosen["selected_by"],
        "observedUtc": chosen["observed_utc"],
        "cost": usage_cost_usd(req.usage, rates),
        "compareBothPeriods": {
            tier: usage_cost_usd(req.usage, PRICING["rates"][tier])["costUsd"]["total"]
            for tier in ("peak", "off_peak")
        },
        "note": f"输出侧按 completion_tokens 计（已含 reasoning_tokens）；数字全部来自 {PRICING.get('_resolvedFile')}。",
    }


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """未捕获异常也要给结构化 JSON —— 中间件的日志行已经先写好了。"""
    return JSONResponse(
        status_code=500,
        content={"ok": False, "path": request.url.path, "error": type(exc).__name__, "detail": str(exc)[:500]},
    )


# --------------------------------------------------------------------------------------
# 自检：把价格算术钉死，防止"改一半"（--selftest）
# --------------------------------------------------------------------------------------


def _force_utf8_stdio() -> None:
    """
    把本进程的 stdout/stderr 顶到 UTF-8。

    为什么必须做（实测踩过）：本文件全程输出中文与 ✓/✗。Windows 中文控制台默认 GBK，
    打印 ✓（U+2713）会直接 `UnicodeEncodeError` 崩掉 —— 而 `--selftest` 正是价格闸门，
    它崩掉就等于"这道闸门没人验"，比不写还糟。子进程我们早就用 PYTHONIOENCODING 保护了
    （见文件头第 2 条），唯独自己的 stdout 漏了。
    errors="replace" 是兜底：万一某个字符仍然打不出，宁可显示成 ? 也不要让闸门挂掉。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
            if enc != "utf8":
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            # 被重定向到不支持 reconfigure 的对象（某些测试夹具）时，不要为了"美化日志"再抛一次
            pass


def _selftest() -> int:
    failures: list[str] = []

    def check(name: str, got: Any, want: Any) -> None:
        if got != want:
            failures.append(f"{name}: 期望 {want!r}，实际 {got!r}")

    peak = PRICING["rates"]["peak"]
    off = PRICING["rates"]["off_peak"]

    # 1) 价格表不变式：off-peak 必须是 peak 的一半（表是用户给的，这条防手改改错）
    for f in ("inputCacheHitPerMillion", "inputCacheMissPerMillion", "outputPerMillion"):
        check(f"off_peak.{f} == peak.{f}/2", off[f], peak[f] / 2)

    # 2) 手算基准（peak，三种 token 各 1M）：
    #    0.006（缓存命中） + 0.30（缓存未命中） + 1.20（输出） = 1.506 USD
    #    注意 prompt_tokens = hit + miss = 2M：输入侧必须**拆成命中/未命中两段分别计价**
    #    （命中价便宜 50 倍），所以夹具也得按这个形状给。
    #    第一版这里写成 prompt=1M/hit=1M/miss=0 却期望 1.506，被 --selftest 当场抓出来——
    #    这正是留着这个自检的意义：价格算术不能靠"看着差不多"。
    full = {"prompt_tokens": 2_000_000, "prompt_cache_hit_tokens": 1_000_000, "prompt_cache_miss_tokens": 1_000_000, "completion_tokens": 1_000_000}
    check("peak 1M hit + 1M miss + 1M out", usage_cost_usd(full, peak)["costUsd"]["total"], 1.506)

    # 2b) 全命中：1M hit = 0.006。这条防的是"把命中价当未命中价算"（会变成 0.30，差 50 倍）
    all_hit = {"prompt_tokens": 1_000_000, "prompt_cache_hit_tokens": 1_000_000, "prompt_cache_miss_tokens": 0, "completion_tokens": 0}
    check("peak 全命中 1M = 0.006", usage_cost_usd(all_hit, peak)["costUsd"]["total"], 0.006)

    # 3) 1M 全 miss + 1M 输出 off-peak = 0.15 + 0.60 = 0.75
    miss = {"prompt_tokens": 1_000_000, "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 1_000_000, "completion_tokens": 1_000_000}
    check("off_peak 1M miss + 1M out", usage_cost_usd(miss, off)["costUsd"]["total"], 0.75)

    # 4) 缺 miss 字段时按 prompt-hit 推算：hit 2M / prompt 3M → miss 1M
    #    peak: 2*0.006 + 1*0.30 = 0.312
    derived = {"prompt_tokens": 3_000_000, "prompt_cache_hit_tokens": 2_000_000, "completion_tokens": 0}
    d = usage_cost_usd(derived, peak)
    check("缺 miss 字段推算", d["costUsd"]["total"], 0.312)
    check("推算出的 miss", d["inputCacheMissTokens"], 1_000_000)
    check("推算被标注", any("推算" in m for m in d["missingFields"]), True)

    # 5) 输出侧只按 completion_tokens 计：reasoning_tokens 不得额外加钱
    with_reasoning = {"prompt_tokens": 0, "prompt_cache_hit_tokens": 0, "completion_tokens": 1_000_000, "completion_tokens_details": {"reasoning_tokens": 900_000}}
    check("reasoning 不重复计", usage_cost_usd(with_reasoning, off)["costUsd"]["total"], 0.6)

    # 6) 时段判定：UTC 周一 02:00 = peak；UTC 周一 00:30 = off-peak；UTC 周六 02:00 = off-peak
    mon = datetime(2026, 10, 12, tzinfo=timezone.utc)  # 2026-10-12 是周一
    check("周一 02:00 UTC = peak", is_peak_utc(mon.replace(hour=2))[0], True)
    check("周一 03:59 UTC = peak", is_peak_utc(mon.replace(hour=3, minute=59))[0], True)
    check("周一 04:00 UTC = off-peak（右开区间）", is_peak_utc(mon.replace(hour=4))[0], False)
    check("周一 00:30 UTC = off-peak", is_peak_utc(mon.replace(hour=0, minute=30))[0], False)
    check("周一 06:30 UTC = peak", is_peak_utc(mon.replace(hour=6, minute=30))[0], True)
    check("周一 10:00 UTC = off-peak（右开区间）", is_peak_utc(mon.replace(hour=10))[0], False)
    check("周六 02:00 UTC = off-peak", is_peak_utc(mon.replace(day=17, hour=2))[0], False)

    # 7) 价格表只有一份，且生效的必须是它。
    #    以前这里有 service/pricing.json 与 bench/pricing.json 两份副本，外加一道"两边数字要一致"的闸门。
    #    闸门只在有人跑 --selftest 时才生效，挡不住"改了其中一份就分叉"——两个真相就是一个太多。
    #    现在断言更强：唯一来源必须是 bench/pricing.json，而且它必须真的被用上、副本必须不存在。
    check("唯一价格表路径就是 bench/pricing.json", PRICING_FILE, REPO_ROOT / "bench" / "pricing.json")
    check("价格表确实存在", PRICING_FILE.exists(), True)
    check("生效的价格表就是唯一那份", PRICING.get("_resolvedPath"), str(PRICING_FILE))
    check("service/ 下不再有第二份价格表副本", (SERVICE_DIR / "pricing.json").exists(), False)
    # 官方不变式：off-peak 各项恰为 peak 的一半。改表时改错一半，这三条会立刻红。
    check("off-peak 命中价 = peak 的一半", off["inputCacheHitPerMillion"] * 2, peak["inputCacheHitPerMillion"])
    check("off-peak 未命中价 = peak 的一半", off["inputCacheMissPerMillion"] * 2, peak["inputCacheMissPerMillion"])
    check("off-peak 输出价 = peak 的一半", off["outputPerMillion"] * 2, peak["outputPerMillion"])
    print(f"  价格表 唯一来源：{PRICING.get('_resolvedFile')} —— {PRICING.get('_resolvedSource')}")

    # 8) 脚本在不在（不算错，只是把环境事实报出来）
    for p in (LINT_MJS, ALIGN_MJS, RETRIEVE_MJS):
        print(f"  脚本 {'✓' if p.exists() else '✗ 缺失'} {p.relative_to(REPO_ROOT) if p.exists() else p}")

    if failures:
        print("✗ --selftest 失败：", file=sys.stderr)
        for f in failures:
            print("   · " + f, file=sys.stderr)
        return 1
    print(f"✓ --selftest 全部通过（{MODEL_ID}，peak {peak['outputPerMillion']} / off_peak {off['outputPerMillion']} USD/M 输出）")
    return 0


if __name__ == "__main__":
    _force_utf8_stdio()   # 必须在任何中文/✓ 输出之前；否则 GBK 控制台下直接崩
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    print("这是 FastAPI 应用模块，直接跑没有意义。", file=sys.stderr)
    print("启动：.venv\\Scripts\\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000", file=sys.stderr)
    print("自检：.venv\\Scripts\\python.exe app.py --selftest", file=sys.stderr)
    raise SystemExit(2)
