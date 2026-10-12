/**
 * deepseek.mjs — 零依赖的 DeepSeek chat/completions 客户端（仅供包外的 bench / security / service 用）。
 *
 * 为什么不放进 npm 包：包对 DSH STORE 承诺"零运行期依赖、不联网、无凭据"。
 * 这个文件联网、要 key，所以它**必须**留在包外（package.json 的 files 不含 bench/）。
 * 包内的检索/lint/align 全是纯本地计算，两边边界不能糊。
 *
 * 凭据来源（按顺序，绝不打印 key）：
 *   1) --key-file <path> 指定的 YAML/文本
 *   2) 环境变量 DEEPSEEK_API_KEY
 *   3) $DSH_HOME/.credentials.yaml 里的 DEEPSEEK_API_KEY（本机 DSH 就是存这里的）
 *
 * 实测要点（2026-10，本机真实调用得出）：
 *   - 可用模型只有 deepseek-flash 与 deepseek-v4-pro（GET /models 实测）。
 *   - deepseek-flash 是**推理模型**：一次 45 字输入的调用里 176 个输出 token 有 167 个是
 *     reasoning_tokens。所以 max_tokens 要给够，否则答案还没开始就被截断；成本也要按输出计。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';

/** 读 key：--key-file > env > $DSH_HOME/.credentials.yaml。返回 { key, source }，不打印内容。 */
export function resolveApiKey({ keyFile = null, env = process.env } = {}) {
  if (keyFile) {
    const k = extractKeyFromText(fs.readFileSync(keyFile, 'utf8'));
    if (!k) throw new Error(`--key-file ${keyFile} 里没找到 DEEPSEEK_API_KEY`);
    return { key: k, source: `--key-file ${keyFile}` };
  }
  if (env.DEEPSEEK_API_KEY) return { key: env.DEEPSEEK_API_KEY, source: 'env:DEEPSEEK_API_KEY' };

  const dshHome = env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const cred = path.join(dshHome, '.credentials.yaml');
  if (fs.existsSync(cred)) {
    const k = extractKeyFromText(fs.readFileSync(cred, 'utf8'));
    if (k) return { key: k, source: `${cred}（DSH 凭据，未打印）` };
  }
  throw new Error(
    '找不到 DeepSeek API key。三种给法：\n' +
      '  · 环境变量：DEEPSEEK_API_KEY=sk-...\n' +
      '  · 显式文件：--key-file <含 DEEPSEEK_API_KEY 的 yaml/txt>\n' +
      '  · 依赖本机 DSH 凭据：$DSH_HOME/.credentials.yaml'
  );
}

/** 从任意文本里抠出 DEEPSEEK_API_KEY 的值（DSH 凭据是 YAML，一行一个 key） */
export function extractKeyFromText(text) {
  const m = String(text).match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^\s"']+)["']?\s*$/m);
  return m ? m[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调一次 chat/completions。
 * @returns {Promise<{text, usage, model, finishReason, ms, attempts}>}
 */
export async function chat({
  key,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  messages,
  temperature = 1.0,
  maxTokens = 4000,
  thinking = null,
  retries = 3,
  timeoutMs = 180000,
  fetchImpl = globalThis.fetch,
}) {
  if (!key) throw new Error('chat() 需要 key（用 resolveApiKey() 拿）');
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const payload = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      };
      // deepseek-flash 默认是推理模型：实测一次 45 字输入的调用里 176 个输出 token 有 167 个是
      // reasoning_tokens，极端情况下推理会把预算吃光、正文一个字都不剩（实测 c1 档 3/9 条空输出）。
      // 消融要求四档生成器完全一致，所以统一关掉思考，并把这个设置写进 manifest。
      if (thinking) payload.thinking = thinking;

      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        if (!retryable || attempt === retries) throw lastErr;
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const json = JSON.parse(body);
      const choice = json.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? '',
        usage: json.usage ?? {},
        model: json.model ?? model,
        ms: Date.now() - t0,
        attempts: attempt,
      };
    } catch (e) {
      lastErr = e;
      if (attempt === retries) throw lastErr;
      await sleep(1000 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 列出可用模型（用于确认 --model 写对了） */
export async function listModels({ key, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`GET /models 失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id);
}

// 这里原本还有一个 costOf()。它已删除：成本算法只允许有一份（bench/pricing.mjs），
// 而它用的是另一套字段名（pricing.inputPerMillion），等于给"两份价格表各算各的"留了后门，
// 而且全仓库没有任何调用点——留着就是等着别人误用。

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  // 注意别写成 argv[argv.indexOf('--k') + 1]：参数不存在时 indexOf 返回 -1，+1 正好是 argv[0]，
  // 会把下一个无关参数当成取值（本文件就踩过一次：--models 被当成 --key-file 的值）。
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  try {
    const { key, source } = resolveApiKey({ keyFile: arg('--key-file') });
    console.log(`✓ key 已解析（来源：${source}，长度 ${key.length}，前缀 ${key.slice(0, 3)}…）`);
    if (argv.includes('--models')) {
      const models = await listModels({ key, baseUrl: arg('--base-url', DEFAULT_BASE_URL) });
      console.log('可用模型：' + models.join(' / '));
    }
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}
