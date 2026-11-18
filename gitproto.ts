// Git object model, pack read/write, pkt-line framing and reachability.
// Stdlib only (node:crypto, node:zlib). No git binary, no filesystem.

import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly body: Buffer;
}

export interface ObjectStore {
  getObject(oid: string): GitObject | undefined;
  putObject(obj: GitObject): string;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, body]));
}

export function makeObject(type: ObjectType, body: Buffer): GitObject {
  return { type, body };
}

export function objectOid(obj: GitObject): string {
  return hashObject(obj.type, obj.body);
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** The mode git writes on the wire for a directory ('40000', no leading zero). */
function wireMode(mode: string): string {
  return mode === '040000' ? '40000' : mode;
}

export function buildTree(entries: readonly TreeEntry[]): GitObject {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${wireMode(entry.mode)} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return { type: 'tree', body: Buffer.concat(parts) };
}

export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) break;
    // Git stores a directory's mode as '40000' (no leading zero); normalise to '040000'.
    const rawMode = body.subarray(offset, space).toString('utf8');
    const mode = rawMode === '40000' ? '040000' : rawMode;
    const nul = body.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = body.subarray(space + 1, nul).toString('utf8');
    const oid = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): GitObject {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author}`, `committer ${opts.committer}`, '', opts.message);
  return { type: 'commit', body: Buffer.from(lines.join('\n'), 'utf8') };
}

export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(body: Buffer): TagInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

/** Binary-safe pkt-line framing for an arbitrary payload (no UTF-8 round-trip). */
export function pktLineBuf(payload: Buffer): Buffer {
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Parse a buffer of pkt-lines into data strings (flush/delim/response-end dropped). */
export function decodePktLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      offset += 4;
      continue;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return lines;
}

/** Split a buffer into raw pkt-line packets (kind + payload), stopping at the first bad length. */
export function parsePktPackets(buf: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }> {
  const packets: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (PACK_TYPE_CODE[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a pack (plain objects, no deltas) from the given objects. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.body.length));
    parts.push(zlib.deflateSync(obj.body));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

function inflateOne(buf: Buffer): Promise<{ out: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = zlib.createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (chunk: Buffer) => chunks.push(chunk));
    inf.on('error', reject);
    inf.on('end', () => resolve({ out: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.end(buf);
  });
}

/** Parse a pack into objects (resolves REF_DELTA/OFS_DELTA if present). */
export async function parsePack(buf: Buffer): Promise<GitObject[]> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: GitObject[] = [];
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    let byte = buf[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: base offset (variable length, offset encoding)
      byte = buf[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(startOffset - baseOffset);
      if (!base) throw new Error('delta base not found');
      const { out, consumed } = await inflateOne(buf.subarray(offset));
      offset += consumed;
      const body = applyDelta(base.body, out);
      const obj: GitObject = { type: base.type, body };
      objects.push(obj);
      byOffset.set(startOffset, obj);
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base oid
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.find((o) => objectOid(o) === baseOid);
      if (!base) throw new Error('delta base not found');
      const { out, consumed } = await inflateOne(buf.subarray(offset));
      offset += consumed;
      const body = applyDelta(base.body, out);
      const obj: GitObject = { type: base.type, body };
      objects.push(obj);
      byOffset.set(startOffset, obj);
    } else {
      const type = PACK_CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const { out, consumed } = await inflateOne(buf.subarray(offset));
      offset += consumed;
      if (out.length !== size) throw new Error('pack object size mismatch');
      const obj: GitObject = { type, body: out };
      objects.push(obj);
      byOffset.set(startOffset, obj);
    }
  }
  return objects;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (opcode > 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      total += opcode;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/** Wrap a pack's bytes in sideband band-1 packets (chunked), then a flush. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLineBuf(payload));
  }
  if (pack.length === 0) {
    parts.push(pktLineBuf(Buffer.from([1])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// reachability and history
// ---------------------------------------------------------------------------------------------

/** All objects reachable from the given tips (commits, their trees/blobs, tags peeled). */
export function reachableObjects(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (isObjectId(tip) && !seen.has(tip)) {
      seen.add(tip);
      queue.push(tip);
    }
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const obj = store.getObject(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const info = parseCommit(obj.body);
      if (!seen.has(info.tree)) {
        seen.add(info.tree);
        queue.push(info.tree);
      }
      for (const parent of info.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.body)) {
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          queue.push(entry.oid);
        }
      }
    } else if (obj.type === 'tag') {
      const info = parseTag(obj.body);
      if (!seen.has(info.object)) {
        seen.add(info.object);
        queue.push(info.object);
      }
    }
  }
  return seen;
}

/**
 * Objects reachable from `tips`, except that a commit in `boundary` contributes itself plus
 * its tree/blobs but NOT its parents. This is how a shallow clone's `have` lines are read:
 * the client holds the boundary commit but none of its ancestors.
 */
export function reachableBounded(store: ObjectStore, tips: readonly string[], boundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (isObjectId(tip) && !seen.has(tip)) {
      seen.add(tip);
      queue.push(tip);
    }
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const obj = store.getObject(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const info = parseCommit(obj.body);
      if (!seen.has(info.tree)) {
        seen.add(info.tree);
        queue.push(info.tree);
      }
      if (boundary.has(oid)) continue;
      for (const parent of info.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.body)) {
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          queue.push(entry.oid);
        }
      }
    } else if (obj.type === 'tag') {
      const info = parseTag(obj.body);
      if (!seen.has(info.object)) {
        seen.add(info.object);
        queue.push(info.object);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The merge-base of two commits (first common ancestor, BFS by generation). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  ancestorsA.set(a, 0);
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift()!;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (!ancestorsA.has(parent)) {
        ancestorsA.set(parent, depth + 1);
        queueA.push([parent, depth + 1]);
      }
    }
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>([b]);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, depth] = queueB.shift()!;
    const depthA = ancestorsA.get(oid);
    if (depthA !== undefined) {
      const score = depthA + depth;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.body).parents) {
      if (!seenB.has(parent)) {
        seenB.add(parent);
        queueB.push([parent, depth + 1]);
      }
    }
  }
  return best;
}

export interface DepthResult {
  readonly objects: Set<string>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * Reachable objects from `tips` limited to `depth` generations of commits (depth 1 = the tips
 * only). Commits at the cutoff are reported as shallow; prior shallow boundaries whose parents
 * are now included are reported as unshallow.
 */
export function depthLimitedReachable(
  store: ObjectStore,
  tips: readonly string[],
  depth: number,
  priorShallow: readonly string[],
): DepthResult {
  const objects = new Set<string>();
  const shallow: string[] = [];
  const commitDepth = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const tip of tips) {
    if (!isObjectId(tip)) continue;
    const obj = store.getObject(tip);
    if (obj && obj.type === 'tag') {
      // A tag want contributes the tag object itself and deepens from its target commit.
      objects.add(tip);
      const target = parseTag(obj.body).object;
      if (isObjectId(target) && !commitDepth.has(target)) {
        commitDepth.set(target, 0);
        queue.push([target, 0]);
      }
      continue;
    }
    if (!commitDepth.has(tip)) {
      commitDepth.set(tip, 0);
      queue.push([tip, 0]);
    }
  }
  while (queue.length > 0) {
    const [oid, depthSoFar] = queue.shift()!;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    objects.add(oid);
    const info = parseCommit(obj.body);
    objects.add(info.tree);
    if (depthSoFar + 1 >= depth) {
      // This commit is at the cutoff: its parents are NOT included.
      shallow.push(oid);
      continue;
    }
    for (const parent of info.parents) {
      if (!commitDepth.has(parent)) {
        commitDepth.set(parent, depthSoFar + 1);
        queue.push([parent, depthSoFar + 1]);
      }
    }
  }
  // Expand the trees/blobs of the included commits. A tree already present in `objects`
  // still needs expanding (its entries are not yet in the set), so track expansion separately.
  const expandedTrees = new Set<string>();
  const treeQueue: string[] = [];
  for (const oid of objects) {
    const obj = store.getObject(oid);
    if (obj && obj.type === 'commit') treeQueue.push(parseCommit(obj.body).tree);
  }
  while (treeQueue.length > 0) {
    const oid = treeQueue.pop()!;
    if (expandedTrees.has(oid)) continue;
    expandedTrees.add(oid);
    objects.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.body)) treeQueue.push(entry.oid);
  }
  // Tags peeled from included commits are already in `objects` via the tree walk; tags pointing
  // at included commits are handled by the caller's tip expansion.
  const unshallow: string[] = [];
  for (const boundary of priorShallow) {
    if (!objects.has(boundary)) continue;
    const obj = store.getObject(boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.body).parents;
    if (parents.length > 0 && parents.every((p) => objects.has(p))) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// tree paths and diffs
// ---------------------------------------------------------------------------------------------

export interface PathEntry {
  readonly path: string;
  readonly oid: string;
  readonly mode: string;
}

/** All blob paths under a tree (recursive). */
export function listTreePaths(store: ObjectStore, treeOid: string, prefix = ''): PathEntry[] {
  const out: PathEntry[] = [];
  const obj = store.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.body)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '040000') {
      out.push(...listTreePaths(store, entry.oid, path));
    } else {
      out.push({ path, oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** The blob oid at a path inside a tree, or null. */
export function getBlobAtPath(store: ObjectStore, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = store.getObject(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.body).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '040000' ? null : entry.oid;
    }
    if (entry.mode !== '040000') return null;
    current = entry.oid;
  }
  return null;
}

/** A new tree with `path` set to `blobOid` (creating intermediate trees as needed). */
export function setPathInTree(store: ObjectStore, treeOid: string, path: string, blobOid: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const build = (currentOid: string | null, depth: number): string => {
    const existing: TreeEntry[] = currentOid ? parseTree(store.getObject(currentOid)?.body ?? Buffer.alloc(0)) : [];
    const name = segments[depth];
    const isLeaf = depth === segments.length - 1;
    const next: TreeEntry[] = [];
    let replaced = false;
    for (const entry of existing) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      replaced = true;
      if (isLeaf) {
        next.push({ mode: '100644', name, oid: blobOid });
      } else {
        next.push({ mode: '040000', name, oid: build(entry.mode === '040000' ? entry.oid : null, depth + 1) });
      }
    }
    if (!replaced) {
      if (isLeaf) next.push({ mode: '100644', name, oid: blobOid });
      else next.push({ mode: '040000', name, oid: build(null, depth + 1) });
    }
    const tree = buildTree(next);
    return store.putObject(tree);
  };
  return build(treeOid, 0);
}

/** A new tree with `path` removed (empty intermediate trees are dropped). */
export function deletePathInTree(store: ObjectStore, treeOid: string, path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const build = (currentOid: string, depth: number): string | null => {
    const existing = parseTree(store.getObject(currentOid)?.body ?? Buffer.alloc(0));
    const name = segments[depth];
    const isLeaf = depth === segments.length - 1;
    const next: TreeEntry[] = [];
    for (const entry of existing) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      if (isLeaf) continue;
      if (entry.mode !== '040000') continue;
      const child = build(entry.oid, depth + 1);
      if (child) next.push({ mode: '040000', name, oid: child });
    }
    if (next.length === 0) return null;
    return store.putObject(buildTree(next));
  };
  const result = build(treeOid, 0);
  if (!result) {
    // The tree became empty: return a fresh empty tree object.
    return store.putObject(buildTree([]));
  }
  return result;
}

export interface FileChange {
  readonly path: string;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** File-level diff between two trees (added/modified/removed). */
export function diffTrees(store: ObjectStore, oldTreeOid: string | null, newTreeOid: string | null): FileChange[] {
  const oldPaths = new Map<string, string>();
  const newPaths = new Map<string, string>();
  if (oldTreeOid) {
    for (const entry of listTreePaths(store, oldTreeOid)) oldPaths.set(entry.path, entry.oid);
  }
  if (newTreeOid) {
    for (const entry of listTreePaths(store, newTreeOid)) newPaths.set(entry.path, entry.oid);
  }
  const changes: FileChange[] = [];
  const allPaths = new Set([...oldPaths.keys(), ...newPaths.keys()]);
  for (const path of [...allPaths].sort()) {
    const oldOid = oldPaths.get(path) ?? null;
    const newOid = newPaths.get(path) ?? null;
    if (oldOid !== newOid) changes.push({ path, oldOid, newOid });
  }
  return changes;
}

/** Line counts for a simple added/deleted tally between two blob contents. */
export function lineDiff(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldContent ? oldContent.toString('utf8').split('\n') : [];
  const newLines = newContent ? newContent.toString('utf8').split('\n') : [];
  // Drop the trailing empty element produced by a final newline on both sides.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  const newCount = new Map<string, number>();
  for (const line of newLines) newCount.set(line, (newCount.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCount) {
    const old = oldCount.get(line) ?? 0;
    if (count > old) additions += count - old;
  }
  for (const [line, count] of oldCount) {
    const next = newCount.get(line) ?? 0;
    if (count > next) deletions += count - next;
  }
  // A file whose only change is a newline shift still counts as a change; keep the tally honest.
  if (additions === 0 && deletions === 0 && (oldContent !== null) !== (newContent !== null)) {
    if (newContent !== null) additions = newLines.length;
    else deletions = oldLines.length;
  }
  return { additions, deletions };
}
