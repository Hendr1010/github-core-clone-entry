// HTTP server: routing, bearer auth, request ids, and the JSON/git framing.
// One process, stdlib only. Mounted by main.ts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { fetchV0, fetchV2, infoRefs, lsRefs, receivePack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { store } from './store.ts';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${Date.now().toString(36)}-${requestCounter.toString(16)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  if (!expected) return true;
  return token === expected;
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp() {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'internal error';
      if (!res.headersSent) {
        sendJson(res, 500, { message });
      } else {
        res.end();
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Health probe: no auth.
  if (path === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Every other call needs the bearer token.
  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const result = handleMcp(raw);
      res.writeHead(result.status, {
        'content-type': 'application/json',
        'x-github-request-id': requestId(),
        ...result.headers,
      });
      res.end(result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL.
  if (path === '/api/graphql' && method === 'POST') {
    const raw = await readBody(req);
    const result = handleGraphQL(raw);
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId(),
    });
    res.end(result.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').filter((s) => s.length > 0);
    const raw = method === 'GET' || method === 'DELETE' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let body: unknown = {};
    if (raw.length > 0) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      body = parsed.value;
    }
    const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
    const result = handleRest({ method, segments, query: url.searchParams, body, baseUrl });
    res.writeHead(result.status, {
      'x-github-request-id': requestId(),
      ...result.headers,
    });
    res.end(result.body);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/...
  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)$/);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3];
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (suffix === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Invalid service' });
        return;
      }
      const protocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const result = infoRefs(repo, service, protocolV2);
      sendBuffer(res, result.status, result.contentType, result.body);
      return;
    }
    if (suffix === '/git-upload-pack' && method === 'POST') {
      const raw = await readBody(req);
      const protocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      try {
        if (protocolV2) {
          const lines = raw.subarray(0, Math.min(raw.length, 200)).toString('utf8');
          if (lines.includes('command=ls-refs')) {
            const body = lsRefs(repo, raw);
            sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
            return;
          }
          const body = fetchV2(repo, raw);
          sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
          return;
        }
        const body = fetchV0(repo, raw);
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
        return;
      } catch {
        // A malformed request still gets a well-formed (empty) answer; the server stays healthy.
        const body = protocolV2 ? fetchV2(repo, Buffer.alloc(0)) : fetchV0(repo, Buffer.alloc(0));
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
        return;
      }
    }
    if (suffix === '/git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      try {
        const body = await receivePack(repo, raw);
        sendBuffer(res, 200, 'application/x-git-receive-pack-result', body);
        return;
      } catch {
        const body = await receivePack(repo, Buffer.alloc(0));
        sendBuffer(res, 200, 'application/x-git-receive-pack-result', body);
        return;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
