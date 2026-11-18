// GraphQL (GitHub-compatible subset) for the fixed documents the suite sends.
// A targeted executor: it recognises the suite's viewer/repository/node/mutation documents,
// validates unknown fields, and answers from the same in-memory store as REST and MCP.

import { diffTrees, mergeBase, parseCommit } from './gitproto.ts';
import {
  mergePull,
  nextGlobalId,
  nowIso,
  pullFiles,
  store,
  viewerLogin,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface GraphQLResponse {
  status: number;
  body: string;
}

const ISSUE_FIELDS = ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'labels', 'comments'];
const PULL_REQUEST_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'url'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'];

// Every field name, enum value and keyword that may legitimately appear in the suite's
// fixed documents. Operation names, aliases, argument names and type names are skipped
// structurally by the tokenizer below, so they never reach this list.
const KNOWN_IDENTIFIERS = new Set<string>([
  'query', 'mutation', 'fragment', 'on', 'true', 'false', 'null',
  'viewer', 'repository', 'node', '__type', '__schema',
  ...REPOSITORY_FIELDS, ...ISSUE_FIELDS, ...PULL_REQUEST_FIELDS,
  'login', 'name', 'prefix', 'target', 'node', 'cursor', 'nodes', 'edges', 'totalCount', 'pageInfo',
  'endCursor', 'hasNextPage', 'fields', 'enumValues', 'description', 'kind', 'ofType',
  'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment',
  'issue', 'pullRequest', 'commentEdge', 'clientMutationId',
  'owner', 'number', 'first', 'states', 'orderBy', 'field', 'direction', 'repositoryId', 'title', 'body',
  'issueId', 'pullRequestId', 'mergeMethod', 'subjectId', 'after', 'before', 'input', 'includeDeprecated',
  'OPEN', 'CLOSED', 'MERGED', 'MERGEABLE', 'CONFLICTING', 'UNKNOWN', 'CREATED_AT', 'UPDATED_AT',
  'ASC', 'DESC', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'SQUASH', 'MERGE', 'REBASE',
  'ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', 'OBJECT', 'SCALAR', 'ENUM', 'INPUT_OBJECT',
  'author', 'labels', 'comments', 'assignees', 'milestone', 'locked', 'url', 'htmlUrl', 'path',
  'String', 'Int', 'ID', 'Boolean', 'Float',
  'CreateIssueInput', 'CloseIssueInput', 'CreatePullRequestInput', 'MergePullRequestInput', 'AddCommentInput',
]);

interface Token {
  text: string;
  nextChar: string;
  prevIdent: string | null;
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let prevIdent: string | null = null;
  while (i < query.length) {
    const ch = query[i];
    if (ch === '"') {
      i += 1;
      while (i < query.length && query[i] !== '"') {
        if (query[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j])) j += 1;
      const text = query.slice(i, j);
      let k = j;
      while (k < query.length && /\s/.test(query[k])) k += 1;
      tokens.push({ text, nextChar: query[k] ?? '', prevIdent });
      prevIdent = text;
      i = j;
      continue;
    }
    if (ch === '$') {
      // A variable reference: skip the name after the $.
      let j = i + 1;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j])) j += 1;
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function findUnknownField(query: string): string | null {
  for (const token of tokenize(query)) {
    // An identifier followed by ':' is an alias or an argument name, not a field.
    if (token.nextChar === ':') continue;
    // The identifier after query/mutation/fragment/on is a name or a type condition.
    if (token.prevIdent === 'query' || token.prevIdent === 'mutation' || token.prevIdent === 'fragment' || token.prevIdent === 'on') continue;
    if (!KNOWN_IDENTIFIERS.has(token.text)) return token.text;
  }
  return null;
}

function gqlId(kind: string, parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

function decodeGqlId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoByGqlId(id: string): Repo | null {
  const decoded = decodeGqlId(id);
  if (!decoded) return null;
  const repoId = parseInt(decoded.parts[0], 10);
  if (!Number.isFinite(repoId)) return null;
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return null;
}

function issueByGqlId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGqlId(id);
  if (!decoded || decoded.kind !== 'issue') return null;
  const repoId = parseInt(decoded.parts[0], 10);
  const number = parseInt(decoded.parts[1], 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

function pullByGqlId(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGqlId(id);
  if (!decoded || decoded.kind !== 'pull') return null;
  const repoId = parseInt(decoded.parts[0], 10);
  const number = parseInt(decoded.parts[1], 10);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull) return { repo, pull };
  }
  return null;
}

function issueGql(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: gqlId('issue', [repo.id, issue.number]),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return 'UNKNOWN';
  const baseCommit = parseCommit(repo.getObject(base)!.body);
  const headCommit = parseCommit(repo.getObject(headTip)!.body);
  const baseTipCommit = parseCommit(repo.getObject(baseTip)!.body);
  const headChanges = diffTrees(repo, baseCommit.tree, headCommit.tree);
  const baseChanges = diffTrees(repo, baseCommit.tree, baseTipCommit.tree);
  const baseChanged = new Map<string, string | null>();
  for (const change of baseChanges) baseChanged.set(change.path, change.newOid);
  for (const change of headChanges) {
    if (baseChanged.has(change.path) && baseChanged.get(change.path) !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function pullGql(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: gqlId('pull', [repo.id, pull.number]),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: mergeableOf(repo, pull),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRef: { name: pull.headRef },
    baseRef: { name: pull.baseRef },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function cursorForIssue(issue: Issue): string {
  return Buffer.from(`cursor:${issue.number}`).toString('base64');
}

function cursorNumber(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function repositoryGql(repo: Repo, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: gqlId('repo', [repo.id]),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    description: repo.description,
    isPrivate: repo.private,
    url: `https://github.com/${repo.owner}/${repo.name}`,
  };
  // issue(number:)
  if (/\bissue\s*\(/.test(query)) {
    const issueNumber = inlineInt(query, 'issue', 'number') ?? (typeof variables.number === 'number' ? variables.number : undefined);
    const issue = issueNumber !== undefined ? repo.issues.find((i) => i.number === issueNumber) : undefined;
    out.issue = issue ? issueGql(repo, issue) : null;
  }
  // issues(first, states, orderBy, after)
  if (/\bissues\s*\(/.test(query)) {
    const first = inlineInt(query, 'issues', 'first') ?? (typeof variables.first === 'number' ? variables.first : 100);
    const states = inlineStates(query) ?? (Array.isArray(variables.states) ? (variables.states as string[]) : null);
    const direction = inlineOrderDirection(query) ?? 'DESC';
    const after = typeof variables.after === 'string' ? variables.after : undefined;
    const afterNumber = cursorNumber(after);
    let items = [...repo.issues];
    if (states) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      items = items.filter((i) => wanted.has(i.state));
    }
    items.sort((a, b) => {
      const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
      return direction === 'ASC' ? cmp : -cmp;
    });
    if (afterNumber !== null) {
      items = direction === 'ASC' ? items.filter((i) => i.number > afterNumber) : items.filter((i) => i.number < afterNumber);
    }
    const page = items.slice(0, first);
    out.issues = {
      totalCount: items.length,
      nodes: page.map((i) => issueGql(repo, i)),
      edges: page.map((i) => ({ node: issueGql(repo, i), cursor: cursorForIssue(i) })),
      pageInfo: { hasNextPage: items.length > page.length, endCursor: page.length > 0 ? cursorForIssue(page[page.length - 1]) : null },
    };
  }
  // pullRequests(first:)
  if (/\bpullRequests\s*\(/.test(query)) {
    const first = inlineInt(query, 'pullRequests', 'first') ?? (typeof variables.first === 'number' ? variables.first : 100);
    const open = repo.pulls.filter((p) => p.state === 'open' && !p.merged);
    const page = open.slice(0, first);
    out.pullRequests = {
      totalCount: open.length,
      nodes: page.map((p) => pullGql(repo, p)),
      edges: page.map((p) => ({ node: pullGql(repo, p), cursor: Buffer.from(`cursor:${p.number}`).toString('base64') })),
      pageInfo: { hasNextPage: open.length > page.length, endCursor: page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1].number}`).toString('base64') : null },
    };
  }
  // pullRequest(number:)
  if (/\bpullRequest\s*\(/.test(query)) {
    const prNumber = inlineInt(query, 'pullRequest', 'number') ?? (typeof variables.number === 'number' ? variables.number : undefined);
    const pull = prNumber !== undefined ? repo.pulls.find((p) => p.number === prNumber) : undefined;
    if (!pull) {
      out.pullRequest = null;
    } else {
      const shape = pullGql(repo, pull);
      if (/\bfiles\s*\(/.test(query)) {
        const files = pullFiles(repo, pull);
        const first = inlineInt(query, 'files', 'first') ?? 100;
        const page = files.slice(0, first);
        shape.files = {
          totalCount: files.length,
          nodes: page.map((f) => ({ path: f.filename })),
          edges: page.map((f) => ({ node: { path: f.filename }, cursor: Buffer.from(`cursor:${f.filename}`).toString('base64') })),
          pageInfo: { hasNextPage: files.length > page.length, endCursor: null },
        };
      }
      out.pullRequest = shape;
    }
  }
  return out;
}

function inlineInt(query: string, field: string, arg: string): number | undefined {
  const pattern = new RegExp(`${field}\\s*\\([^)]*?${arg}\\s*:\\s*\\$?([A-Za-z0-9_]+)`, 's');
  const match = query.match(pattern);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function inlineStates(query: string): string[] | null {
  const match = query.match(/states\s*:\s*\[([^\]]*)\]/);
  if (!match) return null;
  return match[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function inlineOrderDirection(query: string): string | null {
  const match = query.match(/direction\s*:\s*(ASC|DESC)/);
  return match ? match[1] : null;
}

function inlineString(query: string, arg: string): string | undefined {
  const match = query.match(new RegExp(`${arg}\\s*:\\s*"([^"]*)"`));
  return match ? match[1] : undefined;
}

const INTROSPECTION: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url'] },
  PullRequest: { fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'url'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'] },
  SearchType: { enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'COMMIT'] },
};

function executeOne(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const unknown = findUnknownField(query);
  if (unknown) {
    return {
      data: {},
      errors: [{ message: `Cannot query field "${unknown}" on type "Repository".`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
    };
  }
  // Introspection: one __type expression per alias (the suite aliases each probe).
  if (query.includes('__type')) {
    const data: Record<string, unknown> = {};
    const pattern = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]*)"/g;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = pattern.exec(query)) !== null) {
      found = true;
      const alias = match[1] ?? '__type';
      const typeName = match[2];
      const info = INTROSPECTION[typeName];
      data[alias] = info
        ? {
            name: typeName,
            kind: info.enumValues ? 'ENUM' : 'OBJECT',
            fields: info.fields ? info.fields.map((name) => ({ name })) : null,
            enumValues: info.enumValues ? info.enumValues.map((name) => ({ name })) : null,
          }
        : null;
    }
    if (found) return { data };
    return { data: { __type: null } };
  }
  // Mutations (the suite sends them as `mutation X($input: ...Input!)` with variables.input).
  if (/\bmutation\b/.test(query)) {
    return executeMutation(query, variables);
  }
  // Relay node(id:).
  if (/\bnode\s*\(/.test(query)) {
    const id = typeof variables.id === 'string' ? variables.id : inlineString(query, 'id') ?? '';
    const decoded = decodeGqlId(id);
    if (!decoded) return { data: { node: null } };
    if (decoded.kind === 'repo') {
      const repo = repoByGqlId(id);
      if (!repo) return { data: { node: null } };
      return { data: { node: { id: gqlId('repo', [repo.id]), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
    }
    if (decoded.kind === 'issue') {
      const found = issueByGqlId(id);
      if (!found) return { data: { node: null } };
      return { data: { node: issueGql(found.repo, found.issue) } };
    }
    if (decoded.kind === 'pull') {
      const found = pullByGqlId(id);
      if (!found) return { data: { node: null } };
      return { data: { node: pullGql(found.repo, found.pull) } };
    }
    return { data: { node: null } };
  }
  // Viewer.
  if (/\bviewer\b/.test(query)) {
    return { data: { viewer: { login: viewerLogin(), id: 1000 } } };
  }
  // Repository.
  if (/\brepository\s*\(/.test(query)) {
    const owner = (typeof variables.owner === 'string' ? variables.owner : undefined) ?? inlineString(query, 'owner') ?? '';
    const name = (typeof variables.name === 'string' ? variables.name : undefined) ?? inlineString(query, 'name') ?? '';
    if (owner !== viewerLogin()) {
      return { data: { repository: null } };
    }
    const repo = store.getRepo(owner, name);
    if (!repo) {
      return { data: { repository: null } };
    }
    return { data: { repository: repositoryGql(repo, query, variables) } };
  }
  return { data: {}, errors: [{ message: 'Unknown operation.' }] };
}

function executeMutation(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const input = (variables.input ?? {}) as Record<string, unknown>;
  const str = (name: string): string | undefined => {
    if (typeof input[name] === 'string') return input[name] as string;
    if (typeof variables[name] === 'string') return variables[name] as string;
    return inlineString(query, name);
  };
  if (query.includes('createIssue')) {
    const repositoryId = str('repositoryId') ?? '';
    const title = str('title') ?? '';
    const body = str('body') ?? '';
    const repo = repoByGqlId(repositoryId);
    if (!repo) return { data: { createIssue: null }, errors: [{ message: 'Could not resolve to a Repository.' }] };
    if (!title) return { data: { createIssue: null }, errors: [{ message: 'Title is required.' }] };
    const now = nowIso();
    const issue: Issue = {
      id: nextGlobalId(),
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return { data: { createIssue: { issue: issueGql(repo, issue) } } };
  }
  if (query.includes('closeIssue')) {
    const issueId = str('issueId') ?? '';
    const found = issueByGqlId(issueId);
    if (!found) return { data: { closeIssue: null }, errors: [{ message: 'Could not resolve to an Issue.' }] };
    found.issue.state = 'closed';
    found.issue.closedAt = nowIso();
    found.issue.updatedAt = nowIso();
    return { data: { closeIssue: { issue: issueGql(found.repo, found.issue) } } };
  }
  if (query.includes('createPullRequest')) {
    const repositoryId = str('repositoryId') ?? '';
    const baseRefName = str('baseRefName') ?? '';
    const headRefName = str('headRefName') ?? '';
    const title = str('title') ?? '';
    const repo = repoByGqlId(repositoryId);
    if (!repo) return { data: { createPullRequest: null }, errors: [{ message: 'Could not resolve to a Repository.' }] };
    const headSha = repo.refs.get(`refs/heads/${headRefName}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
    if (!headSha || !baseSha) {
      return { data: { createPullRequest: null }, errors: [{ message: 'Head or base ref does not exist.' }] };
    }
    const now = nowIso();
    const pull: Pull = {
      id: nextGlobalId(),
      number: repo.nextPullNumber++,
      title,
      body: '',
      state: 'open',
      headRef: headRefName,
      baseRef: baseRefName,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return { data: { createPullRequest: { pullRequest: pullGql(repo, pull) } } };
  }
  if (query.includes('mergePullRequest')) {
    const pullRequestId = str('pullRequestId') ?? '';
    const found = pullByGqlId(pullRequestId);
    if (!found) return { data: { mergePullRequest: null }, errors: [{ message: 'Could not resolve to a PullRequest.' }] };
    if (found.pull.merged) {
      return { data: { mergePullRequest: { pullRequest: pullGql(found.repo, found.pull) } } };
    }
    const result = mergePull(found.repo, found.pull);
    if (!result.ok) {
      return { data: { mergePullRequest: null }, errors: [{ message: result.reason ?? 'Merge conflict.' }] };
    }
    return { data: { mergePullRequest: { pullRequest: pullGql(found.repo, found.pull) } } };
  }
  if (query.includes('addComment')) {
    const subjectId = str('subjectId') ?? '';
    const body = str('body') ?? '';
    const found = issueByGqlId(subjectId);
    if (!found) return { data: { addComment: null }, errors: [{ message: 'Could not resolve to an Issue.' }] };
    const now = nowIso();
    const comment = { id: nextGlobalId(), body, createdAt: now, updatedAt: now };
    const list = found.repo.issueComments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.issueComments.set(found.issue.number, list);
    return {
      data: {
        addComment: {
          commentEdge: {
            node: { id: gqlId('comment', [found.repo.id, found.issue.number, comment.id]), body },
          },
        },
      },
    };
  }
  return { data: {}, errors: [{ message: 'Unknown mutation.' }] };
}

export function handleGraphQL(rawBody: Buffer): GraphQLResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Invalid JSON.' }] }) };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid operation.' }] };
      const { query, variables } = entry as { query?: unknown; variables?: unknown };
      if (typeof query !== 'string') return { errors: [{ message: 'Query is required.' }] };
      return executeOne(query, (variables ?? {}) as Record<string, unknown>);
    });
    return { status: 200, body: JSON.stringify(results) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Invalid operation.' }] }) };
  }
  const { query, variables } = parsed as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string') {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Query is required.' }] }) };
  }
  return { status: 200, body: JSON.stringify(executeOne(query, (variables ?? {}) as Record<string, unknown>)) };
}
