// Git smart HTTP: info/refs advertisements (v2 and v0), ls-refs, fetch (v2 and v0),
// and receive-pack (v0). Speaks the kit's git client protocol exactly.

import {
  buildPack,
  decodePktLines,
  depthLimitedReachable,
  isObjectId,
  parseCommit,
  parsePack,
  parsePktPackets,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
  pktLineBuf,
  reachableBounded,
  reachableObjects,
  sidebandPack,
  ZERO_OID,
  type GitObject,
} from './gitproto.ts';
import { defaultTip, peelToCommit, type Repo } from './store.ts';

const AGENT = 'forge/1.0';

interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) {
    refs.push({ name: 'HEAD', oid: headOid, symrefTarget: headTarget });
  } else {
    refs.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: headTarget, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefInfo = { name, oid };
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

const V2_CAPABILITIES = [
  'ls-refs=unborn',
  'fetch=shallow unborn',
  'object-format=sha1',
  `agent=${AGENT}`,
];

const V0_UPLOAD_CAPABILITIES = [
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'multi_ack',
  `symref=HEAD:refs/heads/main`,
  `agent=${AGENT}`,
];

const V0_RECEIVE_CAPABILITIES = [
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  `symref=HEAD:refs/heads/main`,
  `agent=${AGENT}`,
];

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  parts.push(pktLine('version 2\n'));
  for (const cap of V2_CAPABILITIES) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPABILITIES : V0_RECEIVE_CAPABILITIES;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const born = refs.filter((r) => !r.unborn && r.name !== 'HEAD');
  if (born.length === 0 && !repo.refs.get(`refs/heads/${repo.defaultBranch}`)) {
    // Empty repo: the capabilities line on the zero oid.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    const head = refs.find((r) => r.name === 'HEAD')!;
    const headCaps = caps.join(' ');
    parts.push(pktLine(`${head.oid} HEAD\0${headCaps}\n`));
    for (const ref of born) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function infoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-upload-pack' && protocolV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: v0Advertisement(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

export function lsRefs(repo: Repo, body: Buffer): Buffer {
  const packets = parsePktPackets(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('command=')) continue;
    if (text.startsWith('agent=')) continue;
    if (text.startsWith('object-format=')) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const hasBornRef = repo.refs.size > 0;
  if (!hasBornRef) {
    // Empty repo: v2 ls-refs sends NO refs at all.
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      if (!unborn) continue;
      let line = `unborn ${ref.name}`;
      if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      parts.push(pktLine(`${line}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2 / v0 fetch
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2FetchRequest(body: Buffer): FetchRequest {
  const packets = parsePktPackets(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
  }
  return req;
}

function parseV0FetchRequest(body: Buffer): FetchRequest {
  const packets = parsePktPackets(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const oid = rest.split(' ')[0];
      if (isObjectId(oid)) req.wants.push(oid);
    } else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7).trim(), 10);
    void seenFlush;
  }
  return req;
}

function collectPackObjects(repo: Repo, req: FetchRequest): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // The wants are used as-is: a tag want contributes the tag object itself (reachableObjects
  // peels it to its target commit), so an annotated tag round-trips in the clone.
  const tips: string[] = [...req.wants];
  const haveReachable = req.haves.length > 0 ? reachableBounded(repo, req.haves, new Set(req.shallow)) : new Set<string>();
  if (req.depth !== null) {
    const result = depthLimitedReachable(repo, tips, req.depth, req.shallow);
    const objects: GitObject[] = [];
    for (const oid of result.objects) {
      if (haveReachable.has(oid)) continue;
      const obj = repo.getObject(oid);
      if (obj) objects.push(obj);
    }
    return { objects, shallow: result.shallow, unshallow: result.unshallow };
  }
  const wanted = reachableObjects(repo, tips);
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (haveReachable.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow: [], unshallow: [] };
}

function packBytesFor(repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const { objects, shallow, unshallow } = collectPackObjects(repo, req);
  return { pack: buildPack(objects), shallow, unshallow };
}

export function fetchV2(repo: Repo, body: Buffer): Buffer {
  const req = parseV2FetchRequest(body);
  const { pack, shallow, unshallow } = packBytesFor(repo, req);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktDelim());
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

export function fetchV0(repo: Repo, body: Buffer): Buffer {
  const req = parseV0FetchRequest(body);
  const { pack, shallow, unshallow } = packBytesFor(repo, req);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function receivePack(repo: Repo, body: Buffer): Promise<Buffer> {
  const packets = parsePktPackets(body);
  const commands: PushCommand[] = [];
  let packStart = body.length;
  // Walk the raw buffer: pkt-lines first, then the raw pack after the first flush.
  let offset = 0;
  let capabilitiesSeen = false;
  while (offset + 4 <= body.length) {
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      offset += 4;
      packStart = offset;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const clean = line.replace(/\n$/, '');
    const nul = clean.indexOf('\0');
    const commandText = nul >= 0 ? clean.slice(0, nul) : clean;
    if (nul >= 0) capabilitiesSeen = true;
    const parts = commandText.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0]) && isObjectId(parts[1]) && parts[2].startsWith('refs/')) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    void capabilitiesSeen;
  }
  void packets;
  const packBytes = body.subarray(packStart);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (commands.length === 0) {
    unpackOk = false;
    unpackDetail = 'no commands';
  } else {
    const hasUpdate = commands.some((c) => c.newOid !== ZERO_OID);
    let packObjects: GitObject[] = [];
    if (hasUpdate) {
      if (packBytes.length === 0) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      } else {
        try {
          packObjects = await parsePack(packBytes);
        } catch {
          unpackOk = false;
          unpackDetail = 'unpacker error';
        }
      }
    }
    if (unpackOk) {
      // Store the pack's objects first (all of them, even for rejected refs: real git keeps them).
      for (const obj of packObjects) repo.putObject(obj);
      for (const command of commands) {
        const current = repo.refs.get(command.ref);
        if (command.newOid === ZERO_OID) {
          // Delete.
          if (!current) {
            results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
          } else if (current !== command.oldOid && command.oldOid !== ZERO_OID) {
            results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
          } else {
            repo.refs.delete(command.ref);
            results.push({ ref: command.ref, ok: true, reason: '' });
          }
          continue;
        }
        if (command.oldOid === ZERO_OID) {
          // Create.
          if (current) {
            results.push({ ref: command.ref, ok: false, reason: 'remote ref already exists' });
            continue;
          }
        } else {
          // Update: old must match, and the new tip must descend from the old one.
          if (!current) {
            results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
            continue;
          }
          if (current !== command.oldOid) {
            results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
            continue;
          }
          if (!isAncestorFast(repo, command.oldOid, command.newOid)) {
            results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
            continue;
          }
        }
        // The new tip must be an object the server now holds (a commit, or a tag for tag refs).
        const tipObj = repo.getObject(command.newOid);
        if (!tipObj || (tipObj.type !== 'commit' && tipObj.type !== 'tag')) {
          results.push({ ref: command.ref, ok: false, reason: 'object not found' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else {
      for (const command of commands) {
        results.push({ ref: command.ref, ok: false, reason: unpackDetail });
      }
    }
  }
  reportLines.push(`unpack ${unpackDetail}\n`);
  for (const result of results) {
    if (result.ok) reportLines.push(`ok ${result.ref}\n`);
    else reportLines.push(`ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([pktLine(reportLines.join('')), pktFlush()]);
  // Sideband band-1 wrapping (the report-status stream is itself pkt-lined inside band 1).
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < report.length; off += CHUNK) {
    const slice = report.subarray(off, Math.min(off + CHUNK, report.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLineBuf(payload));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function isAncestorFast(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const obj = repo.getObject(oid);
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

export { decodePktLines, defaultTip };
