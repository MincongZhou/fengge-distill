# syntax=docker/dockerfile:1
#
# 峰哥体服务化层的镜像。
#
# ⚠️ 构建上下文必须是**仓库根**，不是 service/ —— 因为服务要 exec 仓库里的 node 脚本
#    （skills/.../fengge-lint.mjs、fengge-align.mjs、fengge-retrieve.mjs）并读 bench/report/。
#    所以 Dockerfile 用 `docker build -f service/Dockerfile .` 这样调用（-f 指定文件、. 给上下文）。
#
# 为什么是 node 基础镜像 + apt 装 python，而不是 python 基础镜像 + 装 node：
#     base 里要的东西一半在 node 一侧（三个 .mjs 脚本，实测 node v24 跑通），
#     node:*-slim 已经把 node 装好了；python3 在 debian 仓库里就是几 MB 的事。
#     反过来在 python:slim 上装 node 24 要自己加 NodeSource 源，体积和不确定性都更大。
#
# 两段式：
#    builder —— 装 pip 依赖到独立前缀（/opt/venv）
#    runtime —— 只拷 venv，不带编译工具链

FROM node:24-bookworm-slim AS builder

# python3-venv 在 debian 里是独立包，slim 镜像默认没有
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# 依赖先装：requirements.txt 不变时这一层命中缓存，改业务代码不用重装
WORKDIR /build
COPY service/requirements.txt /build/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r /build/requirements.txt


FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

# 中文 locale 不是必须的（本服务全链路显式 utf-8），但把编码环境钉死，
# 免得将来有人加了一条走 locale 的调用路径后在这里踩到 mojibake。
ENV PYTHONIOENCODING=utf-8 \
    PYTHONUTF8=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LANG=C.UTF-8 \
    FG_NODE=node

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# 整个仓库进镜像：服务要调的三个脚本、bench/report 的指标文件都在里面。
# 注意 npm 包白名单（package.json 的 files）和这里无关——那是发布边界，这是运行镜像边界。
# 真正被排除的是 .dockerignore 里列的东西（.venv / logs / .git）。
WORKDIR /app
COPY . /app

# 容器里以非 root 跑；logs 目录要给写权限（每请求一行 JSONL 就写在这里）
RUN useradd --create-home --uid 10001 fengge \
 && mkdir -p /app/service/logs \
 && chown -R fengge:fengge /app/service/logs
USER fengge

EXPOSE 8000

# 健康检查用 python 自带的 urllib：不在镜像里额外装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status==200 else 1)"

WORKDIR /app/service

# 用 --app-dir 而不是 cd：uvicorn 的 -m 形式会改 sys.path，--app-dir 更明确
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/app/service"]
