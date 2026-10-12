#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
smoke.py — 真跑一遍的冒烟测试：起服务 → 打 6 个端点（含 3 个错误路径）→ 断言关键字段 → 打印结果。

为什么是「起真实 uvicorn + 发真实 HTTP」而不是 FastAPI TestClient：
    TestClient 走的是 ASGI 内存调用，**绕过了真实端口、真实编码边界、真实子进程**。
    这个服务最容易坏的地方恰好就在那三处（node 子进程的中文往返、JSONL 落盘、uvicorn 启动）。
    TestClient 全绿而线上 500 是有可能的，所以这里宁可慢几秒也要打真端口。

用法（先在 service/ 下建好 venv，见 README）：
    service\\.venv\\Scripts\\python.exe service\\smoke.py
    service\\.venv\\Scripts\\python.exe service\\smoke.py --port 8765     # 换个端口

退出码：0 = 全部通过；1 = 有断言失败；2 = 环境问题（venv/依赖没准备好、服务起不来）
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("✗ 缺 requests。先在 service/ 下建 venv 并 pip install -r requirements.txt（见 README）。", file=sys.stderr)
    raise SystemExit(2)

SERVICE_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVICE_DIR.parent
LOG_FILE = SERVICE_DIR / "logs" / "calls.jsonl"

# 断言与打印分开记账：断言失败不会立刻中断，一路跑完再汇总，方便一次看清坏了几处。
RESULTS: list[tuple[bool, str, str]] = []


def record(ok: bool, name: str, detail: str = "") -> None:
    RESULTS.append((bool(ok), name, detail))
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))


def show(label: str, obj) -> None:
    """紧凑打印返回摘要（截断），控制台不好看中文也不影响——真正的证据在 stdout 文件里。"""
    text = json.dumps(obj, ensure_ascii=False)
    if len(text) > 600:
        text = text[:600] + f"…(共 {len(text)} 字符)"
    print(f"    {label}: {text}")


def free_port(preferred: int) -> int:
    """优先用指定端口；被占用就让内核给一个，避免"跑不起来"被误判成服务坏了。"""
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise SystemExit(2)


def check_venv() -> None:
    """
    硬性检查：跑在 service/.venv 里，而不是 C:\\veighna_studio\\python.exe。
    为什么非要拦：那是另一个产品的解释器，往里装 fastapi 会污染它（任务里的硬要求）。
    """
    forced = os.environ.get("FG_SMOKE_PYTHON")
    if forced:
        print(f"· 解释器（FG_SMOKE_PYTHON 指定）：{sys.executable}")
        return
    if os.name == "nt":
        expected = (SERVICE_DIR / ".venv" / "Scripts" / "python.exe").resolve()
    else:
        expected = (SERVICE_DIR / ".venv" / "bin" / "python").resolve()
    actual = Path(sys.executable).resolve()
    if actual != expected:
        print(f"✗ 必须用 service/.venv 里的解释器跑，当前是：{actual}", file=sys.stderr)
        print(f"  期望：{expected}", file=sys.stderr)
        print("  建 venv 的命令见 service/README.md「怎么起」一节。", file=sys.stderr)
        raise SystemExit(2)
    print(f"· 解释器：{actual}")


def log_offset() -> int:
    """记录跑测试前的日志大小，结束时报「本次新增了几行」——不动别人的历史账。"""
    return LOG_FILE.stat().st_size if LOG_FILE.exists() else 0


def tail_lines(offset: int) -> list[dict]:
    if not LOG_FILE.exists():
        return []
    with open(LOG_FILE, "r", encoding="utf-8") as fh:
        fh.seek(offset)
        rows = []
        for line in fh:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return rows


def _force_utf8_stdio() -> None:
    """
    把本进程的 stdout/stderr 顶到 UTF-8。

    为什么必须做（实测踩过）：本脚本全程输出中文与 ✓/✗。Windows 中文控制台默认 GBK，
    打印 ✓（U+2713）会 `UnicodeEncodeError` 直接崩在**第一条断言**上——而且是崩在清理之前，
    于是 uvicorn 子进程被留在后台、端口不释放，下一次跑就"端口被占用"。
    也就是说：一个只在 `PYTHONIOENCODING=utf-8` 下才能跑通的冒烟测试，等于没有冒烟测试。
    errors="replace" 兜底：万一仍打不出，宁可显示成 ? 也不要让测试挂掉。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            enc = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
            if enc != "utf8":
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main() -> int:
    _force_utf8_stdio()   # 必须在任何中文/✓ 输出之前
    port_arg = 8000
    argv = sys.argv[1:]
    if "--port" in argv:
        port_arg = int(argv[argv.index("--port") + 1])

    check_venv()
    print(f"· 仓库根：{REPO_ROOT}")

    # 依赖自检：fastapi/uvicorn 不在就早说，不要等到 uvicorn 起不来才报 ImportError
    for mod in ("fastapi", "uvicorn"):
        try:
            __import__(mod)
        except ImportError:
            print(f"✗ 缺 {mod}。cd service && .venv\\Scripts\\python.exe -m pip install -r requirements.txt", file=sys.stderr)
            return 2

    port = free_port(port_arg)
    base = f"http://127.0.0.1:{port}"
    print(f"· 端口：{port}（请求端口 {port_arg}）")

    # ---- 起服务 ----------------------------------------------------------------
    # 关键：env 里带上 PYTHONIOENCODING/PYTHONUTF8。父进程若在 GBK 代码页下，
    # 不带这两个变量时 uvicorn 的日志（含中文异常）会在写 stdout 时炸掉。
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONPATH"] = str(SERVICE_DIR) + os.pathsep + env.get("PYTHONPATH", "")

    creationflags = 0x00000008 if os.name == "nt" else 0  # CREATE_NEW_PROCESS_GROUP：便于整组收掉
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=str(SERVICE_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
    )
    print(f"· 已启动：{sys.executable} -m uvicorn app:app --host 127.0.0.1 --port {port}（pid={proc.pid}）")

    started_at = datetime.now(timezone.utc)
    before_offset = log_offset()
    exit_code = 1
    try:
        # 等健康检查通过（最多 ~30s：首次 import fastapi 有时要几秒）
        ready = False
        deadline = time.time() + 30
        last_err = ""
        while time.time() < deadline:
            if proc.poll() is not None:
                last_err = f"服务进程提前退出，rc={proc.returncode}"
                break
            try:
                r = requests.get(f"{base}/health", timeout=2)
                if r.status_code == 200:
                    ready = True
                    break
            except requests.RequestException as exc:
                last_err = str(exc)
            time.sleep(0.4)

        if not ready:
            print(f"✗ 服务没起来：{last_err}", file=sys.stderr)
            if proc.poll() is not None:
                print("---- 服务 stdout/stderr ----", file=sys.stderr)
                print(proc.stdout.read() if proc.stdout else "", file=sys.stderr)
            return 2

        print(f"· 服务就绪（{datetime.now(timezone.utc).isoformat(timespec='seconds')}）\n")

        # ---- 1. GET /health ---------------------------------------------------
        print("[1] GET /health")
        r = requests.get(f"{base}/health", timeout=10)
        show("返回", r.json() if r.status_code == 200 else r.text)
        h = r.json() if r.status_code == 200 else {}
        record(r.status_code == 200, "/health 返回 200", f"status={r.status_code}")
        for field in ("ok", "version", "model", "pricing_source"):
            record(field in h, f"/health 含字段 {field}")
        record(h.get("ok") is True, "/health ok=true")
        record(h.get("model") == "deepseek-flash", "/health model=deepseek-flash", str(h.get("model")))
        record(
            isinstance(h.get("pricing_source"), dict) and "url" in h["pricing_source"],
            "/health pricing_source 带来源 URL",
            str((h.get("pricing_source") or {}).get("url")),
        )
        record(
            h.get("pricing_period") in ("peak", "off_peak"),
            "/health 显式声明时段（peak/off_peak）",
            f"{h.get('pricing_period')} ← {h.get('pricing_period_selected_by')}",
        )

        # ---- 2. POST /lint（中文 + 故意触发规则） --------------------------------
        print("\n[2] POST /lint（中文文案，故意同时触发 FAIL 与 WARN）")
        bad_text = "你们天天上班我满仓，个人观点，点位看到4000，对吧？我算了算这账。"
        r = requests.post(f"{base}/lint", json={"text": bad_text, "form": "short"}, timeout=60)
        show("返回", r.json() if r.status_code == 200 else r.text)
        lint = r.json() if r.status_code == 200 else {}
        record(r.status_code == 200, "/lint 返回 200（脚本 FAIL 时退出码 1，服务仍应 200）", f"status={r.status_code}")
        rep = lint.get("report") or {}
        record(isinstance(rep.get("results"), list) and len(rep["results"]) > 0, "/lint report.results 非空", f"{len(rep.get('results') or [])} 条")
        record(lint.get("fails", 0) and lint["fails"] > 0, "/lint 检出 FAIL（该文案确实违规）", f"fails={lint.get('fails')} warns={lint.get('warns')}")
        # 中文往返的正确性证据：脚本数出来的字数必须等于我们传进去的字数
        record(rep.get("len") == len(bad_text), "/lint 字数往返一致（中文没被编码改写）", f"脚本 {rep.get('len')} vs 本地 {len(bad_text)}")
        rules = " ".join(x.get("rule", "") for x in (rep.get("results") or []))
        record("个人观点" in rules or "免责句" in rules, "/lint 命中免责句规则", rules)

        # ---- 2b. 错误路径：form 非法 -------------------------------------------
        print("\n[2b] POST /lint form=长文（非法值，必须 422 而不是静默回落）")
        r = requests.post(f"{base}/lint", json={"text": "测试", "form": "长文"}, timeout=30)
        show("返回", r.json() if r.text else r.text)
        record(r.status_code == 422, "非法 form 返回 422", f"status={r.status_code}")

        # ---- 2c. 超长文案：验证日志摘要真的被截断 ------------------------------
        # 用 400 字的真实中文长文打 /lint。这个请求的目的不是看 lint 判什么，
        # 而是留下一条「请求体远长于上限」的日志行，好断言摘要确实被截断了。
        print("\n[2c] POST /lint 超长文案（验证日志摘要截断）")
        long_text = "上班第一天，公司让我把工牌别在胸口，说这是规矩。" * 10  # 约 240 字
        r = requests.post(f"{base}/lint", json={"text": long_text, "form": "long"}, timeout=60)
        show("返回摘要", {"status": r.status_code, "len_in": len(long_text), "fails": (r.json() or {}).get("fails") if r.status_code == 200 else None})
        record(r.status_code == 200, "超长文案 /lint 返回 200", f"status={r.status_code}")
        record(((r.json() or {}).get("report") or {}).get("len") == len(long_text), "超长中文往返字数一致", str(len(long_text)))

        # ---- 3. POST /align ---------------------------------------------------
        print("\n[3] POST /align（3 条中文样本）")
        texts = [
            "峰哥满仓上班，今天赚了300块，回家吃碗面。",
            "我994一克买的黄金反倒红了，这波我不慌。",
            "公司发的中秋福利是一句祝福，值0块",
        ]
        r = requests.post(f"{base}/align", json={"texts": texts}, timeout=90)
        show("返回", r.json() if r.status_code == 200 else r.text)
        al = r.json() if r.status_code == 200 else {}
        record(r.status_code == 200, "/align 返回 200", f"status={r.status_code}")
        arep = al.get("report") or {}
        record(arep.get("n") == len(texts), "/align 样本数等于传入条数", f"n={arep.get('n')}")
        record(isinstance(arep.get("rows"), list) and len(arep["rows"]) > 10, "/align rows 是特征明细", f"{len(arep.get('rows') or [])} 行")
        record(isinstance(al.get("score"), (int, float)), "/align 有 score", str(al.get("score")))
        first = (arep.get("rows") or [{}])[0]
        record(bool(first.get("特征")), "/align 行里有中文字段名（UTF-8 往返正常）", str(first.get("特征")))

        # ---- 4. POST /retrieve ------------------------------------------------
        print("\n[4] POST /retrieve（中文查询）")
        r = requests.post(f"{base}/retrieve", json={"query": "公司要求下班后微信待命", "k": 3}, timeout=120)
        show("返回", r.json() if r.status_code == 200 else r.text)
        rt = r.json() if r.status_code == 200 else {}
        if r.status_code == 200:
            record(rt.get("query") == "公司要求下班后微信待命", "/retrieve 查询回显一致（中文往返）", str(rt.get("query")))
            record(isinstance(rt.get("hits"), list) and len(rt["hits"]) > 0, "/retrieve 返回 hits", f"{len(rt.get('hits') or [])} 条")
            record(all("score" in x and "text" in x for x in (rt.get("hits") or [])), "/retrieve 每条 hit 有 score/text")
            record(isinstance(rt.get("eligible"), int) and rt["eligible"] > 0, "/retrieve eligible 语料条数 > 0", f"eligible={rt.get('eligible')} skipped={rt.get('skipped')}")
            print(f"    corpus: {rt.get('corpus')}")
            print(f"    top1:   {(rt.get('hits') or [{}])[0].get('text', '')[:70]}")
        else:
            # 语料是包外数据，不在仓库里。这时正确的行为是 503 + 说清楚缺什么，而不是返回空 hits。
            detail = rt.get("detail") if isinstance(rt.get("detail"), dict) else {}
            record(r.status_code == 503, "/retrieve 无语料时返回 503（不假装检索成功）", f"status={r.status_code}")
            record("语料" in json.dumps(detail, ensure_ascii=False), "/retrieve 503 里说明了缺语料", str(detail.get("hint", ""))[:80])

        # ---- 5. GET /metrics/summary -----------------------------------------
        print("\n[5] GET /metrics/summary")
        report_dir = REPO_ROOT / "bench" / "report"
        run_ids = sorted(p.stem[len("metrics-"):] for p in report_dir.glob("metrics-*.json")) if report_dir.exists() else []
        if not run_ids:
            record(False, "bench/report 下没有 metrics-*.json，无法验证 /metrics/summary", str(report_dir))
        else:
            run_id = run_ids[-1]
            r = requests.get(f"{base}/metrics/summary", params={"runId": run_id}, timeout=30)
            show("返回", r.json() if r.status_code == 200 else r.text)
            ms = r.json() if r.status_code == 200 else {}
            record(r.status_code == 200, f"/metrics/summary 返回 200（runId={run_id}）", f"status={r.status_code}")
            metrics = ms.get("metrics") or {}
            record(metrics.get("runId") == run_id, "/metrics/summary 透出的 runId 一致", str(metrics.get("runId")))
            record("conditions" in metrics, "/metrics/summary 含 conditions", f"{list((metrics.get('conditions') or {}).keys())}")
            record(isinstance(metrics.get("control"), dict), "/metrics/summary 含 control 组")

        # ---- 5b/5c. 错误路径 --------------------------------------------------
        print("\n[5b] GET /metrics/summary 路径穿越与不存在的 runId")
        r = requests.get(f"{base}/metrics/summary", params={"runId": "../../../etc/passwd"}, timeout=30)
        show("返回", r.json() if r.text else r.text)
        record(r.status_code == 400, "runId 含 .. 时返回 400（路径穿越被挡）", f"status={r.status_code}")
        r = requests.get(f"{base}/metrics/summary", params={"runId": "run-does-not-exist-0000"}, timeout=30)
        show("返回", r.json() if r.text else r.text)
        record(r.status_code == 404, "不存在的 runId 返回 404", f"status={r.status_code}")
        if r.status_code == 404:
            detail = r.json().get("detail") or {}
            record("availableRunIds" in detail, "404 里列出了可用的 runId（可自助排查）", str(detail.get("availableRunIds"))[:80])

        # ---- 6. POST /cost/estimate + GET /cost ------------------------------
        print("\n[6] POST /cost/estimate（把算钱这条路径钉死）")
        usage = {
            "prompt_tokens": 1_000_000,
            "prompt_cache_hit_tokens": 200_000,
            "prompt_cache_miss_tokens": 800_000,
            "completion_tokens": 100_000,
            "completion_tokens_details": {"reasoning_tokens": 90_000},
        }
        r = requests.post(f"{base}/cost/estimate", json={"usage": usage, "period": "off_peak"}, timeout=30)
        show("返回", r.json() if r.status_code == 200 else r.text)
        ce = r.json() if r.status_code == 200 else {}
        cost = ce.get("cost") or {}
        # 手算：200k/1M*0.003 + 800k/1M*0.15 + 100k/1M*0.60 = 0.0006+0.12+0.06 = 0.1806
        record(abs((cost.get("costUsd") or {}).get("total", -1) - 0.1806) < 1e-9, "off_peak 估价 == 手算 0.1806", str((cost.get("costUsd") or {}).get("total")))
        record(abs((ce.get("compareBothPeriods") or {}).get("peak", -1) - 0.3612) < 1e-9, "peak 估价 == 手算 0.3612（恰为两倍）", str((ce.get("compareBothPeriods") or {}).get("peak")))
        record(cost.get("outputPricedOn") == "completion_tokens", "输出侧声明按 completion_tokens 计", str(cost.get("outputPricedOn")))

        print("\n[6b] GET /cost（累计；本次跑出的请求应已入账）")
        r = requests.get(f"{base}/cost", timeout=30)
        show("返回", r.json() if r.status_code == 200 else r.text)
        c = r.json() if r.status_code == 200 else {}
        record(r.status_code == 200, "/cost 返回 200", f"status={r.status_code}")
        record(set(("today", "week", "all")) <= set(c.get("buckets") or {}), "/cost 有 today/week/all 三个桶", str(list((c.get("buckets") or {}).keys())))
        record(c.get("callsLogged", 0) > 0, "/cost 读到了调用日志", f"callsLogged={c.get('callsLogged')}")
        record(c.get("currentPricingPeriod") in ("peak", "off_peak"), "/cost 声明当前时段", f"{c.get('currentPricingPeriod')} ({c.get('currentPricingPeriodSelectedBy')})")

        # 定位「哪一笔调用带 usage」：这只是 /cost/estimate 那次（我们显式喂了 usage）。
        # 本地 node 工具不产生 token，所以 **除它之外** 的行 usage 必须全是 null —— 断言这个，
        # 而不是断言全局 callsWithUsage==0（那样会被 estimate 那次合法地打破）。
        rows_after_estimate = tail_lines(before_offset)
        estimate_rows = [x for x in rows_after_estimate if x.get("path") == "/cost/estimate"]
        node_rows = [x for x in rows_after_estimate if x.get("path") in ("/lint", "/align", "/retrieve")]
        record(len(estimate_rows) == 1, "只有 /cost/estimate 那笔带 usage", f"{len(estimate_rows)} 行")
        record(
            all(x.get("usage") is None for x in node_rows) and len(node_rows) >= 4,
            "本地 node 调用（lint/align/retrieve）全部无 token（如实记账，不编用量）",
            f"{len(node_rows)} 行全为 null",
        )
        record(
            (c.get("buckets", {}).get("all", {}).get("costUsd") or 0) > 0,
            "/cost 把 estimate 那笔的用量算进了累计（costUsd>0 来自显式 usage，不是编的）",
            f"all={c.get('buckets', {}).get('all')}",
        )

        # ---- 7. JSONL 日志内容核对 -------------------------------------------
        print("\n[7] service/logs/calls.jsonl 逐行核对")
        rows = tail_lines(before_offset)
        print(f"    本次新增 {len(rows)} 行（起始偏移 {before_offset} 字节）")
        record(len(rows) >= 8, "本次跑出的请求都写了日志行", f"{len(rows)} 行")
        required = {"ts", "path", "elapsedMs", "status", "requestDigest", "usage", "cost"}
        sample = rows[-1] if rows else {}
        missing = required - set(sample)
        record(not missing, "日志行含必需字段", f"缺 {sorted(missing) if missing else '无'}")
        for row in rows[:3]:
            print(f"    {json.dumps(row, ensure_ascii=False)[:280]}")
        # 截断的实证：那条 240 字的超长文案在日志里必须被折叠
        long_rows = [x for x in rows if x.get("path") == "/lint"]
        digests = [(x.get("requestDigest") or {}).get("text") for x in long_rows if isinstance(x.get("requestDigest"), dict)]
        clipped = [d for d in digests if isinstance(d, str) and "…" in d]
        record(bool(clipped), "日志里超长请求体被截断（不会把全文写进账本）", (clipped[0][-40:] if clipped else "没有一条带截断标记"))
        record(all(len(d) <= 220 for d in digests if isinstance(d, str)), "所有 /lint 摘要都不超过 220 字符（含长度标注）", f"最长 {max((len(d) for d in digests if isinstance(d, str)), default=0)} 字符")
        record(all(isinstance(x.get("elapsedMs"), int) for x in rows), "每行都有耗时 ms")
        # 错误路径也要有日志：状态码非 200 的行必须在
        non200 = [x for x in rows if x.get("status") not in (200,)]
        record(len(non200) >= 3, "非 200 请求也进了日志（中间件覆盖全部请求）", f"{len(non200)} 行")

        exit_code = 1 if any(not ok for ok, _, _ in RESULTS) else 0
    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            out = ""
        if out and out.strip():
            print("\n---- 服务侧输出（日志级别 warning，非空说明有异常）----")
            print(out.strip()[:2000])

    # ---- 汇总 -----------------------------------------------------------------
    passed = sum(1 for ok, _, _ in RESULTS if ok)
    failed = [name for ok, name, _ in RESULTS if not ok]
    print("\n" + "=" * 72)
    print(f"冒烟测试：{passed}/{len(RESULTS)} 项通过")
    if failed:
        print("失败项：")
        for name in failed:
            print("  ✗ " + name)
        print(f"启动命令（复现用）：{sys.executable} -m uvicorn app:app --host 127.0.0.1 --port {port_arg}")
    else:
        print("✓ 全部通过")
    print("=" * 72)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
