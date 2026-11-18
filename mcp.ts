// MCP (JSON-RPC 2.0 over plain HTTP, legacy era): initialize, tools/list and the six
// forge tools, all backed by the same in-memory store as REST and GraphQL.
// `server/discover` answers method-not-found so the client falls back to the legacy handshake.

import {
  issueShape,
  mergePull,
  nextGlobalId,
  nowIso,
  pullShape,
  repoShape,
  resolveRef,
  store,
  viewerLogin,
} from './store.ts';

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login (defaults to the authenticated user).' }),
        name: Object.freeze({ type: 'string', description: 'Repository name.' }),
        description: Object.freeze({ type: 'string', description: 'Repository description.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Issue title.' }),
        body: Object.freeze({ type: 'string', description: 'Issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'Pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function okResult(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(name: string): ToolResult {
  return errorResult(`Missing required argument: ${name}`);
}

function callTool(name: string, args: Record<string, unknown>): ToolResult {
  if (name === 'create_repo') {
    const repoName = args.name;
    if (typeof repoName !== 'string' || !repoName) return missingArg('name');
    const owner = typeof args.owner === 'string' && args.owner ? args.owner : viewerLogin();
    if (owner !== viewerLogin()) return errorResult(`Cannot create a repository for ${owner}.`);
    if (store.getRepo(owner, repoName)) return errorResult(`Repository ${owner}/${repoName} already exists.`);
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(owner, repoName, description, isPrivate);
    return okResult(repoShape(repo) as Record<string, unknown>);
  }
  if (name === 'get_repo') {
    const owner = args.owner;
    const repoName = args.repo;
    if (typeof owner !== 'string' || !owner) return missingArg('owner');
    if (typeof repoName !== 'string' || !repoName) return missingArg('repo');
    const repo = owner === viewerLogin() ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found.`);
    return okResult(repoShape(repo) as Record<string, unknown>);
  }
  if (name === 'create_issue') {
    const owner = args.owner;
    const repoName = args.repo;
    const title = args.title;
    if (typeof owner !== 'string' || !owner) return missingArg('owner');
    if (typeof repoName !== 'string' || !repoName) return missingArg('repo');
    if (typeof title !== 'string' || !title) return missingArg('title');
    const repo = owner === viewerLogin() ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const now = nowIso();
    const issue = {
      id: nextGlobalId(),
      number: repo.nextIssueNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels: [] as string[],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return okResult(issueShape(repo, issue) as Record<string, unknown>);
  }
  if (name === 'list_issues') {
    const owner = args.owner;
    const repoName = args.repo;
    if (typeof owner !== 'string' || !owner) return missingArg('owner');
    if (typeof repoName !== 'string' || !repoName) return missingArg('repo');
    const repo = owner === viewerLogin() ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const items = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
    return okResult({ issues: items.map((i) => issueShape(repo, i)) });
  }
  if (name === 'create_pull_request') {
    const owner = args.owner;
    const repoName = args.repo;
    const title = args.title;
    const head = args.head;
    const base = args.base;
    if (typeof owner !== 'string' || !owner) return missingArg('owner');
    if (typeof repoName !== 'string' || !repoName) return missingArg('repo');
    if (typeof title !== 'string' || !title) return missingArg('title');
    if (typeof head !== 'string' || !head) return missingArg('head');
    if (typeof base !== 'string' || !base) return missingArg('base');
    const repo = owner === viewerLogin() ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const headSha = resolveRef(repo, head);
    const baseSha = resolveRef(repo, base);
    if (!headSha || !baseSha) return errorResult('Head or base branch does not exist.');
    const now = nowIso();
    const pull = {
      id: nextGlobalId(),
      number: repo.nextPullNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return okResult(pullShape(repo, pull) as Record<string, unknown>);
  }
  if (name === 'merge_pull_request') {
    const owner = args.owner;
    const repoName = args.repo;
    const pullNumber = args.pull_number;
    if (typeof owner !== 'string' || !owner) return missingArg('owner');
    if (typeof repoName !== 'string' || !repoName) return missingArg('repo');
    if (typeof pullNumber !== 'number') return missingArg('pull_number');
    const repo = owner === viewerLogin() ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const pull = repo.pulls.find((p) => p.number === pullNumber);
    if (!pull) return errorResult(`Pull request #${pullNumber} not found.`);
    if (pull.merged) return errorResult(`Pull request #${pullNumber} is already merged.`);
    const result = mergePull(repo, pull);
    if (!result.ok) return errorResult(result.reason ?? 'Cannot merge.');
    return okResult({ merged: true, number: pull.number, sha: result.mergeCommitSha ?? null, message: `Pull Request #${pull.number} successfully merged` });
  }
  return errorResult(`Unknown tool: ${name}`);
}

export function handleMcp(rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const message = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in message && message.id !== undefined;
  const id = hasId ? message.id : null;
  // Notifications (no id): acknowledge with 202 and no body.
  if (!hasId) {
    return { status: 202, headers: {}, body: '' };
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  const respond = (result: unknown): McpResponse => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  const respondError = (code: number, text: string): McpResponse => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: text } }),
  });
  if (method === 'server/discover') {
    return respondError(-32601, 'Method not found');
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (!LEGACY_REVISIONS.includes(requested)) {
      return respondError(-32602, `Unsupported protocol version: ${requested}`);
    }
    return respond({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }
  if (method === 'ping') {
    return respond({});
  }
  if (method === 'tools/list') {
    return respond({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((t) => t.name === toolName);
    if (!known) {
      return respondError(-32602, `Unknown tool: ${toolName}`);
    }
    const result = callTool(toolName, args);
    return respond(result);
  }
  return respondError(-32601, 'Method not found');
}
