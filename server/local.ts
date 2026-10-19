/**
 * 本地调试服务器
 *
 * EdgeOne Makers 的 Agent 入口签名是 onRequest(context)，context 里的 tools / store / utils
 * 都由平台注入。本项目脱离平台在本地跑时没有这些东西，这里补一个最小实现：
 *   - tools.web_search  → 直接调腾讯云联网搜索 API（读 WSA_API_KEY）
 *   - store             → 进程内内存版会话历史
 *   - utils.abortActiveRun → 按 conversation_id 中止正在进行的流式回复
 *
 * 启动：npm run dev:server（tsx 加载 TS，端口 8088，与 vite.config.ts 的代理目标一致）
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { onRequest as chatOnRequest } from '../agents/chat/index';
import { onRequest as stopOnRequest } from '../agents/stop';

// 读取 .env（Node 22 内置，无需 dotenv）；文件不存在时忽略
try {
  process.loadEnvFile('.env');
} catch {
  /* 没有 .env 就用当前进程环境变量 */
}

const PORT = Number(process.env.PORT ?? 8088);

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 进程内会话历史，重启即清空；仅用于本地调试多轮对话 */
const conversations = new Map<string, StoredMessage[]>();
/** 每个会话正在进行的请求对应的中止器 */
const controllers = new Map<string, AbortController>();

/**
 * 联网搜索工具，对齐平台 web_search 的入参与返回结构
 * 上游是腾讯云联网搜索 API（元宝搜索），鉴权方式为 Bearer + 服务 API KEY
 */
const webSearch = tool({
  name: 'web_search',
  description: '联网搜索互联网公开信息，用于查询竞品格局、市场规模、融资与成败案例。返回标题、链接、摘要、来源站点。',
  parameters: z.object({
    query: z.string().describe('搜索关键词，中英文均可'),
    maxResults: z.number().int().positive().optional().describe('返回条数，默认 5'),
    site: z.string().optional().describe('限定站点域名，例如 zhihu.com'),
  }),
  async execute({ query, maxResults, site }) {
    const key = process.env.WSA_API_KEY;
    if (!key) {
      return '搜索不可用：未配置 WSA_API_KEY。请在 .env 中填入腾讯云联网搜索 API 的服务密钥。';
    }

    const resp = await fetch('https://api.wsa.cloud.tencent.com/SearchPro', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ Query: site ? `${query} site:${site}` : query }),
    });

    const data: any = await resp.json().catch(() => ({}));
    const payload = data.Response ?? data;

    if (payload?.Error) {
      return `搜索失败：${payload.Error.Code} ${payload.Error.Message ?? ''}`.trim();
    }

    // 上游 Pages 是「JSON 字符串数组」，每条需要再解析一次
    const pages: any[] = Array.isArray(payload?.Pages) ? payload.Pages : [];
    const results = pages.slice(0, maxResults ?? 5).map((raw) => {
      try {
        const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          title: p.title ?? '',
          href: p.url ?? '',
          snippet: p.passage ?? '',
          site: p.site ?? '',
          date: p.date ?? '',
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (results.length === 0) return '没有搜索到相关结果。';
    return JSON.stringify(results);
  },
});

const tools = {
  all: () => [webSearch],
  get: (name: string) => (name === 'web_search' ? webSearch : undefined),
  files: () => [],
  browser: () => [],
};

const store = {
  async getMessages({ conversationId }: { conversationId: string }) {
    return conversations.get(conversationId) ?? [];
  },
  toOpenAIInput(history: StoredMessage[]) {
    return history.map((m) => ({ role: m.role, content: m.content }));
  },
  async appendMessage({ conversationId, role, content }: StoredMessage & { conversationId: string }) {
    const list = conversations.get(conversationId) ?? [];
    list.push({ role, content });
    // 只保留最近 50 条，避免无限增长
    if (list.length > 50) list.splice(0, list.length - 50);
    conversations.set(conversationId, list);
  },
};

const utils = {
  abortActiveRun(conversationId: string) {
    const controller = controllers.get(conversationId);
    if (!controller) return { aborted: false };
    controller.abort();
    controllers.delete(conversationId);
    return { aborted: true };
  },
};

const CONV_ID_PATTERN = /^[0-9a-zA-Z\-_.]{6,36}$/;

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** 把 onRequest 返回的 Web Response 原样写回 Node 的 http 响应，SSE 需要边读边写 */
async function pipeResponse(response: Response, res: ServerResponse) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (path !== '/chat' && path !== '/stop') {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const body = await readJson(req);
  const rawId = req.headers['makers-conversation-id'];
  const conversationId = Array.isArray(rawId) ? rawId[0] : rawId;

  if (path === '/stop') {
    const response = await stopOnRequest({
      request: { body },
      utils,
    });
    await pipeResponse(response, res);
    return;
  }

  // 与平台一致：缺少或非法 conversation-id 直接 400
  if (!conversationId || !CONV_ID_PATTERN.test(conversationId)) {
    sendJson(res, 400, {
      error: 'Invalid makers-conversation-id: header is missing or malformed. Required: 6-36 characters, allowed: [0-9a-zA-Z-_.]',
    });
    return;
  }

  const controller = new AbortController();
  controllers.set(conversationId, controller);
  res.on('close', () => {
    // 客户端提前断开时中止上游，避免继续消耗 token
    if (!res.writableEnded) controller.abort();
    if (controllers.get(conversationId) === controller) controllers.delete(conversationId);
  });

  try {
    const response = await chatOnRequest({
      request: { body, headers: req.headers, signal: controller.signal },
      env: process.env,
      tools,
      store,
      utils,
      conversation_id: conversationId,
    });
    await pipeResponse(response, res);
  } catch (e) {
    const err = e as Error;
    console.error('[local] 处理请求失败:', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[local] Agent 后端已启动：http://localhost:${PORT}`);
  console.log(`[local] 模型：${process.env.AI_GATEWAY_MODEL ?? '(未设置)'}`);
  console.log(`[local] 联网搜索：${process.env.WSA_API_KEY ? '已配置' : '未配置 WSA_API_KEY'}`);
});
