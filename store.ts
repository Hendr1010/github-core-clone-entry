// The forge's in-memory store: repositories, git objects, refs, issues, pulls, labels, comments.
// Everything lives in Maps; there is no filesystem and no network. One store per process.

import {
  buildCommit,
  buildTree,
  deletePathInTree,
  diffTrees,
  getBlobAtPath,
  hashObject,
  isObjectId,
  lineDiff,
  listTreePaths,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  setPathInTree,
  ZERO_OID,
  type GitObject,
  type ObjectStore,
} from './gitproto.ts';
import { viewerOfScenario, type Viewer } from './scenario.ts';

export interface RepoMeta {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo extends RepoMeta, ObjectStore {
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  issueComments: Map<number, Comment[]>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

const VIEWER: Viewer = viewerOfScenario();

export function viewerLogin(): string {
  return VIEWER.login;
}

export function viewerIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function nowGitTimestamp(): string {
  const seconds = Math.floor(Date.now() / 1000);
  return `${seconds} +0000`;
}

export function authorLine(): string {
  return `${viewerIdentity()} ${nowGitTimestamp()}`;
}

let globalId = 1;
export function nextGlobalId(): number {
  return globalId++;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const meta: RepoMeta = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const objects = new Map<string, GitObject>();
    const repo: Repo = {
      ...meta,
      refs: new Map<string, string>(),
      objects,
      issues: [],
      pulls: [],
      labels: [],
      issueComments: new Map<number, Comment[]>(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      getObject(oid: string): GitObject | undefined {
        return objects.get(oid);
      },
      putObject(obj: GitObject): string {
        const oid = hashObject(obj.type, obj.body);
        objects.set(oid, obj);
        return oid;
      },
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposForOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------------------------

export function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`repo:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
    license: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    size: 0,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((l) => l.name === name);
      return label ? { id: label.id, name: label.name, color: label.color, description: label.description } : { name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    comments: (repo.issueComments.get(issue.number) ?? []).length,
    locked: false,
    assignees: [],
    milestone: null,
    author_association: 'OWNER',
  };
}

export function pullShape(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`pull:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER.login, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: 'clean',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    author_association: 'OWNER',
  };
}

export function labelShape(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

export function commentShape(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`comment:${repo.id}:${issueNumber}:${comment.id}`).toString('base64'),
    body: comment.body,
    user: { login: VIEWER.login, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

export function branchShape(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

export function commitShape(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.getObject(sha);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.body);
  const author = { name: VIEWER.name, email: VIEWER.email, date: nowIso() };
  return {
    sha,
    node_id: Buffer.from(`commit:${repo.id}:${sha}`).toString('base64'),
    commit: {
      author,
      committer: author,
      message: info.message,
      tree: { sha: info.tree },
    },
    author: { login: VIEWER.login, id: 1000, type: 'User' },
    committer: { login: VIEWER.login, id: 1000, type: 'User' },
    parents: info.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------------------------------------
// git-backed operations shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------------------------

/** Resolve a ref name (branch) or raw oid to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isObjectId(ref)) {
    const obj = repo.getObject(ref);
    return obj && obj.type === 'commit' ? ref : null;
  }
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  return null;
}

/** The default branch's tip commit, or null when the repo is unborn. */
export function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

export interface CommitFileResult {
  commitSha: string;
  blobSha: string;
  existed: boolean;
}

/** Apply a contents-API file write (create or update) on a branch. */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): CommitFileResult {
  const branchRef = `refs/heads/${branch}`;
  const tip = repo.refs.get(branchRef) ?? null;
  const blob = { type: 'blob' as const, body: content };
  const blobSha = repo.putObject(blob);
  let treeOid: string;
  let existed = false;
  if (tip) {
    const tipCommit = parseCommit(repo.getObject(tip)!.body);
    existed = getBlobAtPath(repo, tipCommit.tree, path) !== null;
    treeOid = setPathInTree(repo, tipCommit.tree, path, blobSha);
  } else {
    treeOid = setPathInTree(repo, repo.putObject(buildTree([])), path, blobSha);
  }
  const commit = buildCommit({
    tree: treeOid,
    parents: tip ? [tip] : [],
    author: authorLine(),
    committer: authorLine(),
    message,
  });
  const commitSha = repo.putObject(commit);
  repo.refs.set(branchRef, commitSha);
  repo.updatedAt = nowIso();
  return { commitSha, blobSha, existed };
}

/** Apply a contents-API file delete on a branch. Returns the new commit sha, or null if absent. */
export function deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
  const branchRef = `refs/heads/${branch}`;
  const tip = repo.refs.get(branchRef) ?? null;
  if (!tip) return null;
  const tipCommit = parseCommit(repo.getObject(tip)!.body);
  if (getBlobAtPath(repo, tipCommit.tree, path) === null) return null;
  const treeOid = deletePathInTree(repo, tipCommit.tree, path);
  const commit = buildCommit({
    tree: treeOid,
    parents: [tip],
    author: authorLine(),
    committer: authorLine(),
    message,
  });
  const commitSha = repo.putObject(commit);
  repo.refs.set(branchRef, commitSha);
  repo.updatedAt = nowIso();
  return commitSha;
}

export interface MergeResult {
  ok: boolean;
  reason?: string;
  mergeCommitSha?: string;
}

/** Squash-merge a pull request onto its base branch. */
export function mergePull(repo: Repo, pull: Pull): MergeResult {
  if (pull.merged) return { ok: false, reason: 'already merged' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { ok: false, reason: 'branch not found' };
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return { ok: false, reason: 'no merge base' };
  const baseCommit = parseCommit(repo.getObject(base)!.body);
  const headCommit = parseCommit(repo.getObject(headTip)!.body);
  const baseTipCommit = parseCommit(repo.getObject(baseTip)!.body);
  const headChanges = diffTrees(repo, baseCommit.tree, headCommit.tree);
  const baseChanges = diffTrees(repo, baseCommit.tree, baseTipCommit.tree);
  const baseChanged = new Map<string, string | null>();
  for (const change of baseChanges) baseChanged.set(change.path, change.newOid);
  for (const change of headChanges) {
    if (baseChanged.has(change.path)) {
      const baseNew = baseChanged.get(change.path);
      if (baseNew !== change.newOid) {
        return { ok: false, reason: 'merge conflict' };
      }
    }
  }
  // Apply head's changes onto the base tip's tree.
  let treeOid = baseTipCommit.tree;
  for (const change of headChanges) {
    if (change.newOid === null) {
      treeOid = deletePathInTree(repo, treeOid, change.path);
    } else {
      treeOid = setPathInTree(repo, treeOid, change.path, change.newOid);
    }
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const mergeCommit = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: authorLine(),
    committer: authorLine(),
    message,
  });
  const mergeSha = repo.putObject(mergeCommit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.state = 'closed';
  pull.updatedAt = nowIso();
  pull.baseSha = mergeSha;
  repo.updatedAt = nowIso();
  return { ok: true, mergeCommitSha: mergeSha };
}

/** Files changed by a pull request (merge-base to head), with line tallies. */
export function pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return [];
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseCommit = parseCommit(repo.getObject(base)!.body);
  const headCommit = parseCommit(repo.getObject(headTip)!.body);
  const changes = diffTrees(repo, baseCommit.tree, headCommit.tree);
  return changes.map((change) => {
    const oldBody = change.oldOid ? (repo.getObject(change.oldOid)?.body ?? null) : null;
    const newBody = change.newOid ? (repo.getObject(change.newOid)?.body ?? null) : null;
    const { additions, deletions } = lineDiff(oldBody, newBody);
    const status = change.oldOid === null ? 'added' : change.newOid === null ? 'removed' : 'modified';
    return { filename: change.path, status, additions, deletions, changes: additions + deletions };
  });
}

/** Commit history for a branch, newest first (linear walk following first parents). */
export function listCommits(repo: Repo, ref: string, limit: number): string[] {
  const tip = resolveRef(repo, ref);
  if (!tip) return [];
  const out: string[] = [];
  let current: string | null = tip;
  const seen = new Set<string>();
  while (current && out.length < limit && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    const obj = repo.getObject(current);
    if (!obj || obj.type !== 'commit') break;
    const parents = parseCommit(obj.body).parents;
    current = parents.length > 0 ? parents[0] : null;
  }
  return out;
}

/** Peel a ref oid to its commit (annotated tags resolve to their target commit). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.getObject(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.body).object;
      continue;
    }
    return null;
  }
  return null;
}

export { ZERO_OID, parseTree, listTreePaths };
