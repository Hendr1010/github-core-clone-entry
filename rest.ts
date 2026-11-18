// REST v3 (GitHub-compatible) surface: repos, branches, commits, refs, contents,
// labels, issues, comments, pulls and merges. All state lives in the in-memory store.

import { getBlobAtPath, isObjectId, listTreePaths, parseCommit } from './gitproto.ts';
import {
  branchShape,
  commitFile,
  commitShape,
  defaultTip,
  deleteFile,
  issueShape,
  labelShape,
  commentShape,
  listCommits,
  mergePull,
  nowIso,
  nextGlobalId,
  pullFiles,
  pullShape,
  repoShape,
  resolveRef,
  store,
  viewerLogin,
  type Repo,
} from './store.ts';

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return { status, headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(value) };
}

function error(status: number, message: string): RestResponse {
  return json(status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function notFound(message = 'Not Found'): RestResponse {
  return error(404, message);
}

function repoOr404(owner: string, name: string): Repo | RestResponse {
  if (owner !== viewerLogin()) return notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  return repo;
}

function isRestResponse(value: unknown): value is RestResponse {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

function pagination(req: { query: URLSearchParams }, total: number, baseUrl: string, path: string): { page: number; perPage: number; link: string } {
  const perPage = Math.max(1, Math.min(100, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const linkParts: string[] = [];
  const makeUrl = (p: number): string => {
    const params = new URLSearchParams(req.query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${baseUrl}${path}?${params.toString()}`;
  };
  if (page < totalPages) linkParts.push(`<${makeUrl(page + 1)}>; rel="next"`);
  if (totalPages > 1) linkParts.push(`<${makeUrl(totalPages)}>; rel="last"`);
  if (page > 1) {
    linkParts.push(`<${makeUrl(1)}>; rel="first"`);
    linkParts.push(`<${makeUrl(page - 1)}>; rel="prev"`);
  }
  return { page, perPage, link: linkParts.join(', ') };
}

function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function handleRest(req: RestRequest): RestResponse {
  const { method, segments } = req;
  // Root and meta.
  if (segments.length === 0 && method === 'GET') {
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
      user_url: '/api/v3/users/{username}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return json(200, { login: viewerLogin(), id: 1000, type: 'User', name: 'ada iversen' });
  }
  // POST /user/repos and GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !NAME_RE.test(name) || name.endsWith('.git')) {
        return error(422, 'Validation Failed');
      }
      if (store.getRepo(viewerLogin(), name)) {
        return json(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(viewerLogin(), name, description, isPrivate);
      return json(201, repoShape(repo));
    }
    if (method === 'GET') {
      const all = store.listReposForOwner(viewerLogin());
      const { page, perPage, link } = pagination(req, all.length, req.baseUrl, '/api/v3/user/repos');
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      return json(200, pageOf(all, page, perPage).map((r) => repoShape(r)), headers);
    }
    return notFound();
  }
  // /repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1]);
    const name = decodeURIComponent(segments[2]);
    const found = repoOr404(owner, name);
    if (isRestResponse(found)) return found;
    const repo = found;
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoShape(repo));
      if (method === 'PATCH') {
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updatedAt = nowIso();
        return json(200, repoShape(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, headers: {}, body: '' };
      }
      return notFound();
    }
    return handleRepoSub(req, repo, rest);
  }
  return notFound();
}

function handleRepoSub(req: RestRequest, repo: Repo, rest: string[]): RestResponse {
  const { method } = req;
  const [head, ...tail] = rest;
  // Branches.
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 0) {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      return json(200, branches.map((name) => branchShape(repo, name, repo.refs.get(`refs/heads/${name}`)!)));
    }
    if (method === 'GET' && tail.length === 1) {
      const name = decodeURIComponent(tail[0]);
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (!sha) return notFound('Branch not found');
      return json(200, branchShape(repo, name, sha));
    }
    return notFound();
  }
  // Commits.
  if (head === 'commits') {
    if (method === 'GET' && tail.length === 0) {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (!tip) return notFound('No commit found for SHA');
      const shas = listCommits(repo, ref, 100);
      return json(200, shas.map((sha) => commitShape(repo, sha)).filter((c) => c !== null));
    }
    if (method === 'GET' && tail.length === 1) {
      const sha = decodeURIComponent(tail[0]);
      const shape = commitShape(repo, sha);
      if (!shape) return notFound('No commit found for SHA');
      return json(200, shape);
    }
    return notFound();
  }
  // Git refs.
  if (head === 'git' && tail.length >= 1 && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha)) {
        return error(422, 'Validation Failed');
      }
      if (repo.refs.has(ref)) {
        return json(422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', field: 'ref', message: 'Reference already exists' }] });
      }
      const obj = repo.getObject(sha);
      if (!obj || obj.type !== 'commit') {
        return error(422, 'Object does not exist');
      }
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
    }
    if (method === 'GET' && tail.length >= 2 && tail[1] === 'heads') {
      const branch = tail.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return notFound('Reference does not exist');
      return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
    }
    return notFound();
  }
  // Contents.
  if (head === 'contents') {
    const path = tail.map((s) => decodeURIComponent(s)).join('/');
    return handleContents(req, repo, path);
  }
  // Labels.
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      if (!name) return error(422, 'Validation Failed');
      if (repo.labels.some((l) => l.name === name)) {
        return json(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
      }
      const label = { id: nextGlobalId(), name, color, description: typeof body.description === 'string' ? body.description : '' };
      repo.labels.push(label);
      return json(201, labelShape(label));
    }
    if (method === 'GET' && tail.length === 0) {
      return json(200, repo.labels.map((l) => labelShape(l)));
    }
    return notFound();
  }
  // Issues.
  if (head === 'issues') {
    return handleIssues(req, repo, tail);
  }
  // Pulls.
  if (head === 'pulls') {
    return handlePulls(req, repo, tail);
  }
  return notFound();
}

function resolveBranchForWrite(repo: Repo, requested: string | undefined): string {
  if (!requested) return repo.defaultBranch;
  if (!repo.refs.has(`refs/heads/${requested}`)) {
    const tip = defaultTip(repo);
    if (tip) repo.refs.set(`refs/heads/${requested}`, tip);
  }
  return requested;
}

function handleContents(req: RestRequest, repo: Repo, path: string): RestResponse {
  const { method } = req;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (!tip) return notFound('Not Found');
    const commit = parseCommit(repo.getObject(tip)!.body);
    if (path === '') {
      const entries = listTreePaths(repo, commit.tree);
      const top = new Map<string, { type: string; name: string; path: string; sha: string }>();
      for (const entry of entries) {
        const first = entry.path.split('/')[0];
        if (!top.has(first)) {
          top.set(first, { type: entry.path === first ? 'file' : 'dir', name: first, path: first, sha: entry.oid });
        }
      }
      return json(200, [...top.values()]);
    }
    const blobOid = getBlobAtPath(repo, commit.tree, path);
    if (blobOid) {
      const blob = repo.getObject(blobOid)!;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.body.length,
        name: path.split('/').pop(),
        path,
        content: blob.body.toString('base64'),
        sha: blobOid,
      });
    }
    // Directory listing?
    const entries = listTreePaths(repo, commit.tree).filter((e) => e.path.startsWith(`${path}/`));
    if (entries.length > 0) {
      const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
      for (const entry of entries) {
        const rest = entry.path.slice(path.length + 1);
        const first = rest.split('/')[0];
        const childPath = `${path}/${first}`;
        if (!children.has(childPath)) {
          children.set(childPath, { type: rest === first ? 'file' : 'dir', name: first, path: childPath, sha: entry.oid });
        }
      }
      return json(200, [...children.values()]);
    }
    return notFound('Not Found');
  }
  if (method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    if (!contentB64) return error(422, 'Validation Failed');
    const content = Buffer.from(contentB64.replace(/\n/g, ''), 'base64');
    const branch = resolveBranchForWrite(repo, typeof body.branch === 'string' ? body.branch : undefined);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip) {
      const commit = parseCommit(repo.getObject(tip)!.body);
      const current = getBlobAtPath(repo, commit.tree, path);
      if (typeof body.sha === 'string' && body.sha && current && body.sha !== current) {
        return error(409, 'Conflict');
      }
    }
    const result = commitFile(repo, branch, path, content, message);
    return json(result.existed ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = resolveBranchForWrite(repo, typeof body.branch === 'string' ? body.branch : undefined);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return notFound('Not Found');
    const commit = parseCommit(repo.getObject(tip)!.body);
    const current = getBlobAtPath(repo, commit.tree, path);
    if (!current) return notFound('Not Found');
    if (typeof body.sha === 'string' && body.sha && body.sha !== current) {
      return error(409, 'Conflict');
    }
    const commitSha = deleteFile(repo, branch, path, message);
    if (!commitSha) return notFound('Not Found');
    return json(200, { commit: { sha: commitSha, message } });
  }
  return notFound();
}

function handleIssues(req: RestRequest, repo: Repo, tail: string[]): RestResponse {
  const { method } = req;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) return error(422, 'Validation Failed');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const name of labels) {
        if (!repo.labels.some((l) => l.name === name)) {
          return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `Label does not exist: ${name}` }] });
        }
      }
      const now = nowIso();
      const issue = {
        id: nextGlobalId(),
        number: repo.nextIssueNumber++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open' as const,
        labels,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      return json(201, issueShape(repo, issue));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let items = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      if (sort === 'created') {
        items = [...items].sort((a, b) => {
          const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
          return direction === 'asc' ? cmp : -cmp;
        });
      }
      const { page, perPage, link } = pagination(req, items.length, req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      return json(200, pageOf(items, page, perPage).map((i) => issueShape(repo, i)), headers);
    }
    return notFound();
  }
  const number = parseInt(tail[0], 10);
  if (!Number.isFinite(number)) return notFound();
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound('Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return json(200, issueShape(repo, issue));
    if (method === 'PATCH') {
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const name of labels) {
          if (!repo.labels.some((l) => l.name === name)) {
            return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `Label does not exist: ${name}` }] });
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      return json(200, issueShape(repo, issue));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      if (!text) return error(422, 'Validation Failed');
      const now = nowIso();
      const comment = { id: nextGlobalId(), body: text, createdAt: now, updatedAt: now };
      const list = repo.issueComments.get(number) ?? [];
      list.push(comment);
      repo.issueComments.set(number, list);
      return json(201, commentShape(repo, number, comment));
    }
    if (method === 'GET') {
      const list = repo.issueComments.get(number) ?? [];
      return json(200, list.map((c) => commentShape(repo, number, c)));
    }
    return notFound();
  }
  return notFound();
}

function handlePulls(req: RestRequest, repo: Repo, tail: string[]): RestResponse {
  const { method } = req;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (!title || !head || !base) return error(422, 'Validation Failed');
      const headSha = resolveRef(repo, head);
      const baseSha = resolveRef(repo, base);
      if (!headSha || !baseSha) {
        return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'No commits between base and head' }] });
      }
      const now = nowIso();
      const pull = {
        id: nextGlobalId(),
        number: repo.nextPullNumber++,
        title,
        body: typeof body.body === 'string' ? body.body : '',
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
      return json(201, pullShape(repo, pull));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const items = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      const { page, perPage, link } = pagination(req, items.length, req.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      return json(200, pageOf(items, page, perPage).map((p) => pullShape(repo, p)), headers);
    }
    return notFound();
  }
  const number = parseInt(tail[0], 10);
  if (!Number.isFinite(number)) return notFound();
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return notFound('Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return json(200, pullShape(repo, pull));
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull);
    return json(200, files.map((f) => ({
      sha: '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    })));
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
      return error(422, 'Validation Failed');
    }
    if (pull.merged) {
      return json(405, { message: 'Pull Request is already merged.' });
    }
    const result = mergePull(repo, pull);
    if (!result.ok) {
      return json(405, { message: result.reason === 'merge conflict' ? 'Merge conflict' : result.reason ?? 'Cannot merge' });
    }
    return json(200, { merged: true, message: `Pull Request successfully merged`, sha: result.mergeCommitSha });
  }
  return notFound();
}
