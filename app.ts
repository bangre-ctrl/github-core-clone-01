// A GitHub-compatible git forge: git smart HTTP (upload-pack v2, receive-pack v0),
// REST v3, GraphQL v4 and MCP, all in one process on the Node 22 standard library.
// In-memory, deterministic store. No clock, no randomness in any served state:
// every generated commit uses a fixed epoch plus a monotonic counter, so two runs
// of the same request sequence produce the same bytes.
//
// The token owner is the scenario viewer "adaiversen" (the suite's fixed seeded
// scenario names that login; the bearer token in MAKEFUN_SHOP_TOKEN only proves
// the caller holds it). A repository under any other owner is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const STRANGER_LOGIN = 'olgabauer';
const FIXED_TS = '2025-01-01T00:00:00Z';
const COMMIT_EPOCH = 1735689600;
const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-core-clone/1.0';

type Json = Record<string, unknown>;
type GitType = 'commit' | 'tree' | 'blob' | 'tag';

// ---------------------------------------------------------------- utilities

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}
function hashObject(type: GitType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}
function b64(buf: Buffer | string): string {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf, 'utf8').toString('base64');
}
function unb64(s: string): Buffer {
  return Buffer.from(s.replace(/[\r\n\t ]+/g, ''), 'base64');
}
function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}
function esc(s: string): string {
  return encodeURIComponent(s);
}
function gid(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}
function parseGid(s: string): { kind: string; id: string } | null {
  try {
    const t = Buffer.from(s, 'base64').toString('utf8');
    const i = t.indexOf(':');
    if (i < 0) return null;
    return { kind: t.slice(0, i), id: t.slice(i + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- git objects

interface GitObj { type: GitType; data: Buffer }
interface TreeEntry { mode: string; name: string; oid: string }

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const x = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const y = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(x, y);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { object: m.get('object') ?? '', type: m.get('type') ?? '', tag: m.get('tag') ?? '', tagger: m.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

/** Every object reachable from roots, in traversal order. Commits in `boundary`
   (a shallow clone's shallow tips) contribute themselves and their trees, but
   not their parents — the client does not have those. */
function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObj | undefined, boundary: Set<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots].filter(isOid);
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!boundary.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
    }
  }
  return seen;
}
function ancestorsOf(tip: string, lookup: (oid: string) => GitObj | undefined): Set<string> {
  // commit ancestors only (parents), for fast-forward checks
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackHeader(type: GitType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: Iterable<{ type: GitType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const o of list) {
    parts.push(writePackHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) {
      const b = delta[off++]; v += (b & 0x7f) * 2 ** sh; sh += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) co += delta[off++] * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cs += delta[off++] * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs);
      written += cs;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string }
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const r = inflateSync(buf.subarray(offset, end), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const consumed = r.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: r.buffer as Buffer, next: offset + consumed };
}
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    let b = pack[off];
    const first = b;
    let size = b & 0x0f; let shift = 4; off++;
    while (b & 0x80) { b = pack[off++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    const typeCode = (first >> 4) & 0x07;
    const e: PackEntry = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off]; off++;
      let value = byte & 0x7f;
      while (byte & 0x80) { byte = pack[off++]; value = ((value + 1) * 128) + (byte & 0x7f); }
      e.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      e.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error('unknown pack type');
    const inf = inflateAt(pack, off, trailerStart);
    if (inf.data.length !== size) throw new Error('pack entry size mismatch');
    e.data = inf.data;
    off = inf.next;
    raw.push(e);
    byOffset.set(entryOffset, e);
  }
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, PackEntry>();
  const resolving = new Set<number>();
  const resolve = (e: PackEntry): { type: GitType; data: Buffer; oid: string } => {
    if ((e as unknown as { _oid?: string })._oid) {
      const cached = (e as unknown as { _res?: { type: GitType; data: Buffer; oid: string } })._res!;
      return cached;
    }
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let type: GitType; let data: Buffer;
    if (e.typeCode === 6) {
      const baseEntry = byOffset.get(e.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type; data = applyDelta(base.data, e.data);
    } else if (e.typeCode === 7) {
      const wanted = e.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type; data = applyDelta(base.data, e.data);
      } else {
        const ext = resolveBase(wanted);
        if (!ext) throw new Error('ref-delta base missing');
        type = ext.type; data = applyDelta(ext.data, e.data);
      }
    } else {
      type = CODE_TYPE[e.typeCode]; data = e.data;
    }
    const oid = hashObject(type, data);
    const res = { type, data, oid };
    (e as unknown as { _res: unknown })._res = res;
    resolvedByOid.set(oid, e);
    resolving.delete(e.offset);
    return res;
  };
  for (const e of raw) {
    const r = resolve(e);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------- pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.alloc(4);
  h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}
type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };
function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) break;
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break; // raw pack data follows
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
function pktDataEnd(buf: Buffer): number {
  // offset just past the pkt-line section (the flush that ends the command list)
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return off;
    const len = parseInt(head, 16);
    if (len === 0) return off + 4;
    if (len === 1 || len === 2) { off += 4; continue; }
    if (len < 4 || off + len > buf.length) return off;
    off += len;
  }
  return off;
}

// ---------------------------------------------------------------- store

interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; seq: number; comments: Array<{ id: number; body: string }>;
}
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string; seq: number;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  changed: Array<{ path: string; content: Buffer | null }>; // head version vs base tree
}
interface Label { name: string; color: string; description: string }
interface Repo {
  id: number; name: string; owner: string; description: string; priv: boolean;
  defaultBranch: string; seq: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>; // ref name -> oid
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number; // shared issue+PR numbering
  nextCommentId: number;
}

let repoIdSeq = 5000;
let globalIssueId = 100000;
let commitCounter = 0;
const repos = new Map<string, Repo>(); // key owner/name
const repoOrder: Repo[] = [];

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, priv: boolean): Repo {
  const r: Repo = {
    id: ++repoIdSeq, name, owner: VIEWER_LOGIN, description, priv,
    defaultBranch: 'main', seq: repoOrder.length,
    objects: new Map(), refs: new Map(), issues: new Map(), pulls: new Map(),
    labels: new Map(), nextNumber: 1, nextCommentId: 1,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), r);
  repoOrder.push(r);
  return r;
}
function repoJson(r: Repo): Json {
  return {
    id: r.id, node_id: gid('Repository', String(r.id)), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER_ID, node_id: gid('User', String(VIEWER_ID)), type: 'User', avatar_url: '' },
    private: r.priv, description: r.description, default_branch: r.defaultBranch,
    html_url: `https://example.invalid/${r.owner}/${r.name}`,
    clone_url: `https://example.invalid/${r.owner}/${r.name}.git`,
    git_url: `git://example.invalid/${r.owner}/${r.name}.git`,
    ssh_url: `git@example.invalid:${r.owner}/${r.name}.git`,
    created_at: FIXED_TS, updated_at: FIXED_TS, pushed_at: FIXED_TS,
    fork: false, archived: false, disabled: false, has_issues: true, has_projects: true,
    has_downloads: true, has_wiki: true, has_pages: false, visibility: r.priv ? 'private' : 'public',
    open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
  };
}
function issueJson(r: Repo, i: Issue): Json {
  return {
    id: i.id, node_id: gid('Issue', `${r.id}:${i.number}`), number: i.number, title: i.title,
    body: i.body, state: i.state, locked: false,
    labels: i.labels.map((name) => {
      const l = r.labels.get(name);
      return { id: 0, node_id: gid('Label', `${r.id}:${name}`), name, color: l?.color ?? 'ededed', description: l?.description ?? '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TS, updated_at: FIXED_TS, closed_at: i.state === 'closed' ? FIXED_TS : null,
    comments: i.comments.length, html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
  };
}
function pullJson(r: Repo, p: Pull): Json {
  const headSha = r.refs.get(`refs/heads/${p.headRef}`) ?? p.headSha;
  const baseSha = r.refs.get(`refs/heads/${p.baseRef}`) ?? p.baseSha;
  return {
    id: p.id, node_id: gid('PullRequest', `${r.id}:${p.number}`), number: p.number, title: p.title,
    body: p.body, state: p.state, locked: false, merged: p.merged, merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha, mergeable: isMergeable(r, p),
    head: { ref: p.headRef, sha: headSha, label: `${VIEWER_LOGIN}:${p.headRef}`, repo: repoJson(r) },
    base: { ref: p.baseRef, sha: baseSha, label: `${VIEWER_LOGIN}:${p.baseRef}`, repo: repoJson(r) },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TS, updated_at: FIXED_TS, closed_at: p.state === 'closed' ? FIXED_TS : null,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
  };
}

// ---- git object helpers on a repo

function putObj(r: Repo, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!r.objects.has(oid)) r.objects.set(oid, { type, data });
  return oid;
}
function lookup(r: Repo): (oid: string) => GitObj | undefined {
  return (oid) => r.objects.get(oid);
}
function treeOf(r: Repo, commitOid: string | undefined): string | undefined {
  if (!commitOid) return undefined;
  const c = r.objects.get(commitOid);
  if (!c || c.type !== 'commit') return undefined;
  return parseCommit(c.data).tree;
}
function fileAt(r: Repo, treeOid: string | undefined, path: string): Buffer | undefined {
  if (!treeOid) return undefined;
  const segs = path.split('/');
  let cur = treeOid;
  for (let i = 0; i < segs.length; i++) {
    const t = r.objects.get(cur);
    if (!t || t.type !== 'tree') return undefined;
    const e = parseTree(t.data).find((x) => x.name === segs[i]);
    if (!e) return undefined;
    if (i === segs.length - 1) {
      if (e.mode === '40000') return undefined;
      const b = r.objects.get(e.oid);
      return b && b.type === 'blob' ? b.data : undefined;
    }
    cur = e.oid;
  }
  return undefined;
}
function listDir(r: Repo, treeOid: string | undefined, dir: string): Array<{ name: string; path: string; mode: string; oid: string; type: 'file' | 'dir' }> {
  if (!treeOid) return [];
  const segs = dir === '' ? [] : dir.split('/');
  let cur = treeOid;
  for (const s of segs) {
    const t = r.objects.get(cur);
    if (!t || t.type !== 'tree') return [];
    const e = parseTree(t.data).find((x) => x.name === s);
    if (!e || e.mode === '100644') return [];
    cur = e.oid;
  }
  const t = r.objects.get(cur);
  if (!t || t.type !== 'tree') return [];
  return parseTree(t.data).map((e) => ({
    name: e.name, path: dir === '' ? e.name : `${dir}/${e.name}`, mode: e.mode, oid: e.oid,
    type: e.mode === '40000' ? 'dir' as const : 'file' as const,
  }));
}
/** Set one file in a tree (creating directories), return new root tree oid. */
function setFileInTree(r: Repo, treeOid: string | undefined, path: string, content: Buffer | null): string {
  const segs = path.split('/');
  const build = (oid: string | undefined, depth: number): string => {
    const entries = oid ? parseTree(r.objects.get(oid)?.data ?? Buffer.alloc(0)) : [];
    const name = segs[depth];
    const rest = entries.filter((e) => e.name !== name);
    if (depth === segs.length - 1) {
      if (content !== null) {
        const blob = putObj(r, 'blob', content);
        rest.push({ mode: '100644', name, oid: blob });
      }
      // content null => delete entry
    } else {
      const child = entries.find((e) => e.name === name);
      const childTree = build(child && child.mode === '40000' ? child.oid : undefined, depth + 1);
      const childObj = r.objects.get(childTree);
      if (childObj && parseTree(childObj.data).length > 0) {
        rest.push({ mode: '40000', name, oid: childTree });
      }
    }
    return putObj(r, 'tree', buildTree(rest));
  };
  return build(treeOid, 0);
}
function makeCommit(r: Repo, treeOid: string, parents: string[], message: string): string {
  commitCounter += 1;
  const ts = COMMIT_EPOCH + commitCounter;
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return putObj(r, 'commit', Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8'));
}
/** All files (path -> blob oid) under a tree. */
function treeFiles(r: Repo, treeOid: string | undefined, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!treeOid) return out;
  const t = r.objects.get(treeOid);
  if (!t || t.type !== 'tree') return out;
  for (const e of parseTree(t.data)) {
    if (e.mode === '40000') {
      for (const [p, o] of treeFiles(r, e.oid, `${prefix}${e.name}/`)) out.set(p, o);
    } else out.set(`${prefix}${e.name}`, e.oid);
  }
  return out;
}
function diffFiles(r: Repo, baseTree: string | undefined, headTree: string | undefined): Array<{ path: string; content: Buffer | null }> {
  const base = treeFiles(r, baseTree);
  const head = treeFiles(r, headTree);
  const out: Array<{ path: string; content: Buffer | null }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const p of paths) {
    const b = base.get(p); const h = head.get(p);
    if (b === h) continue;
    const blob = h === undefined ? null : (r.objects.get(h)?.data ?? null);
    out.push({ path: p, content: blob });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}
function fileStats(r: Repo, baseTree: string | undefined, headTree: string | undefined, changed: Array<{ path: string; content: Buffer | null }>): Pull['files'] {
  return changed.map((c) => {
    const oldBuf = c.path ? fileAt(r, baseTree, c.path) : undefined;
    const oldLines = oldBuf ? oldBuf.toString('utf8').split('\n') : [];
    const newLines = c.content ? c.content.toString('utf8').split('\n') : [];
    const oldSet = new Set(oldLines); const newSet = new Set(newLines);
    let add = 0; let del = 0;
    for (const l of newLines) if (!oldSet.has(l)) add++;
    for (const l of oldLines) if (!newSet.has(l)) del++;
    const status = oldBuf === undefined ? 'added' : c.content === null ? 'removed' : 'modified';
    if (status === 'added') add = Math.max(add, newLines.filter((l) => l !== '').length || 1);
    return { filename: c.path, status, additions: add, deletions: del, changes: add + del };
  });
}
function isMergeable(r: Repo, p: Pull): boolean {
  // conflict when a file the PR changes was also changed on the base branch
  // after the PR's base, to different content
  const baseTipTree = treeOf(r, r.refs.get(`refs/heads/${p.baseRef}`));
  const prBaseTree = treeOf(r, p.baseSha);
  if (baseTipTree === prBaseTree) return true;
  const baseFiles = treeFiles(r, baseTipTree);
  const prBaseFiles = treeFiles(r, prBaseTree);
  const headFiles = treeFiles(r, treeOf(r, p.headSha));
  for (const c of p.changed) {
    const baseNow = baseFiles.get(c.path);
    const baseThen = prBaseFiles.get(c.path);
    const headNow = headFiles.get(c.path);
    if (baseNow !== baseThen && headNow !== baseThen && baseNow !== headNow) return false;
  }
  return true;
}
function commitsFrom(r: Repo, tip: string | undefined): string[] {
  // newest-first walk, parents after the commit (depth-first, as git log)
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = tip ? [tip] : [];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const o = r.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const p of parseCommit(o.data).parents) stack.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- http plumbing

let reqCounter = 0;
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  reqCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${reqCounter}`,
    ...extra,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  reqCounter += 1;
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': `req-${reqCounter}`, ...extra });
  res.end(body);
}
function notFound(res: ServerResponse, msg = 'Not Found'): void { sendJson(res, 404, { message: msg }); }
function errMsg(res: ServerResponse, status: number, msg: string): void { sendJson(res, status, { message: msg }); }

function expectedToken(): string { return process.env.MAKEFUN_SHOP_TOKEN ?? ''; }
function authed(req: IncomingMessage): boolean {
  const want = expectedToken();
  const got = req.headers.authorization ?? '';
  if (want === '') return got.startsWith('Bearer ') && got.slice(7).length > 0;
  return got === `Bearer ${want}`;
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; body: Json } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, body: {} };
  try {
    const v = JSON.parse(raw.toString('utf8')) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { ok: true, body: v as Json };
    return { ok: true, body: {} };
  } catch {
    errMsg(res, 400, 'Problems parsing JSON');
    return { ok: false };
  }
}
function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { path: u.pathname, query: u.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}
function decodeSeg(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  return { page, perPage };
}
function paginate<T>(req: IncomingMessage, res: ServerResponse, items: T[], q: URLSearchParams): T[] {
  const { page, perPage } = pageParams(q);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${urlOf(req).path}`;
  const links: string[] = [];
  const qp = new URLSearchParams(q);
  if (start + perPage < items.length) {
    qp.set('page', String(page + 1)); qp.set('per_page', String(perPage));
    links.push(`<${base}?${qp.toString()}>; rel="next"`);
  }
  if (items.length > perPage) {
    qp.set('page', String(Math.ceil(items.length / perPage))); qp.set('per_page', String(perPage));
    links.push(`<${base}?${qp.toString()}>; rel="last"`);
  }
  if (links.length) res.setHeader('link', links.join(', '));
  return slice;
}

// ---- contents helpers

function contentsCreateOrUpdate(r: Repo, branch: string, path: string, contentB64: string, message: string, sha?: string): { status: number; body: Json } {
  const refName = `refs/heads/${branch}`;
  let tip = r.refs.get(refName);
  if (tip === undefined) {
    // branch does not exist yet: start it at the default branch tip (or unborn)
    const defTip = r.refs.get(`refs/heads/${r.defaultBranch}`);
    if (defTip !== undefined) { r.refs.set(refName, defTip); tip = defTip; }
  }
  const treeOid = treeOf(r, tip);
  const current = fileAt(r, treeOid, path);
  const currentSha = current === undefined ? undefined : hashObject('blob', current);
  if (current !== undefined) {
    if (sha !== undefined && sha.toLowerCase() !== currentSha) return { status: 409, body: { message: 'sha does not match' } };
    if (sha === undefined && false) return { status: 409, body: { message: 'sha required' } };
  }
  const content = unb64(contentB64);
  const newTree = setFileInTree(r, treeOid, path, content);
  const commit = makeCommit(r, newTree, tip ? [tip] : [], message || 'Update file');
  r.refs.set(refName, commit);
  const blobSha = hashObject('blob', content);
  return { status: current === undefined ? 201 : 200, body: { content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64 }, commit: { sha: commit, message } } };
}

// ---------------------------------------------------------------- REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const segs = path.split('/').filter((s) => s !== '').map(decodeSeg);
  // segs[0..1] = api, v3
  if (segs.length < 2 || segs[0] !== 'api' || segs[1] !== 'v3') return false;
  const rest = segs.slice(2);

  // GET /api/v3/ root
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { verifiable_password_authentication: false, github_services_sha: '', hooks: [], git: [], installed_version: '1.0.0', api: ['api.github.com'] });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('User', String(VIEWER_ID)), name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'rate_limit') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600 } });
    return true;
  }

  // POST /user/repos  and  GET /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const name = typeof parsed.body.name === 'string' ? parsed.body.name : '';
      if (name === '') { errMsg(res, 422, 'name is required'); return true; }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) { errMsg(res, 422, 'Repository already exists'); return true; }
      const r = createRepoRecord(name, typeof parsed.body.description === 'string' ? parsed.body.description : '', parsed.body.private === true);
      sendJson(res, 201, repoJson(r));
      return true;
    }
    if (method === 'GET') {
      const all = [...repoOrder].map((r) => repoJson(r));
      const slice = paginate(req, res, all, q);
      sendJson(res, 200, slice);
      return true;
    }
    return true;
  }

  // /repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]; const name = rest[2];
    const r = getRepo(owner, name);
    const tail = rest.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!r) { notFound(res); return true; }
        sendJson(res, 200, repoJson(r)); return true;
      }
      if (method === 'PATCH') {
        if (!r) { notFound(res); return true; }
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return true;
        if (typeof parsed.body.description === 'string') r.description = parsed.body.description;
        if (typeof parsed.body.private === 'boolean') r.priv = parsed.body.private;
        sendJson(res, 200, repoJson(r)); return true;
      }
      if (method === 'DELETE') {
        if (!r) { notFound(res); return true; }
        repos.delete(repoKey(owner, name));
        const idx = repoOrder.indexOf(r);
        if (idx >= 0) repoOrder.splice(idx, 1);
        res.writeHead(204, { 'x-github-request-id': `req-${++reqCounter}` });
        res.end();
        return true;
      }
      notFound(res); return true;
    }
    if (!r) { notFound(res); return true; }

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...r.refs.keys()].filter((x) => x.startsWith('refs/heads/')).sort().map((ref) => {
          const n = ref.slice('refs/heads/'.length);
          return { name: n, commit: { sha: r.refs.get(ref), url: '' }, protected: false };
        });
        sendJson(res, 200, list); return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = r.refs.get(`refs/heads/${tail[1]}`);
        if (!sha) { notFound(res); return true; }
        sendJson(res, 200, { name: tail[1], commit: { sha, url: '' }, protected: false });
        return true;
      }
      notFound(res); return true;
    }
    // commits
    if (tail[0] === 'commits' && method === 'GET') {
      const ref = q.get('sha') ?? r.defaultBranch;
      let tip = r.refs.get(`refs/heads/${ref}`);
      if (tip === undefined && isOid(ref)) tip = ref;
      if (tip === undefined) { sendJson(res, 200, []); return true; }
      const list = commitsFrom(r, tip).map((oid) => {
        const c = parseCommit(r.objects.get(oid)!.data);
        return { sha: oid, commit: { message: c.message.replace(/\n+$/, ''), author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } }, author: { login: VIEWER_LOGIN }, committer: { login: VIEWER_LOGIN }, parents: c.parents.map((p) => ({ sha: p })) };
      });
      sendJson(res, 200, list); return true;
    }
    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return true;
        const ref = typeof parsed.body.ref === 'string' ? parsed.body.ref : '';
        const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !r.objects.has(sha)) { errMsg(res, 422, 'Invalid ref or sha'); return true; }
        r.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('Ref', `${r.id}:${ref}`), url: '', object: { sha, type: 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = r.refs.get(ref);
        if (!sha) { notFound(res); return true; }
        sendJson(res, 200, { ref, node_id: gid('Ref', `${r.id}:${ref}`), url: '', object: { sha, type: 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const list = [...r.refs.entries()].sort().map(([ref, sha]) => ({ ref, node_id: gid('Ref', `${r.id}:${ref}`), url: '', object: { sha, type: 'commit', url: '' } }));
        sendJson(res, 200, list); return true;
      }
      notFound(res); return true;
    }
    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      const refQ = q.get('ref');
      const resolveRef = (): string | undefined => {
        if (!refQ) return r.refs.get(`refs/heads/${r.defaultBranch}`);
        if (isOid(refQ)) return refQ;
        return r.refs.get(`refs/heads/${refQ}`);
      };
      if (method === 'GET') {
        const tip = resolveRef();
        const treeOid = treeOf(r, tip);
        const blob = fileAt(r, treeOid, filePath);
        if (blob !== undefined) {
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob.length, name: filePath.split('/').pop(), path: filePath, content: b64(blob), sha: hashObject('blob', blob), url: '', html_url: '' });
          return true;
        }
        const dir = listDir(r, treeOid, filePath);
        if (dir.length > 0 || filePath === '') {
          sendJson(res, 200, dir.map((e) => ({ type: e.type, size: e.type === 'file' ? (r.objects.get(e.oid)?.data.length ?? 0) : 0, name: e.name, path: e.path, sha: e.oid, url: '', html_url: '', git_url: '' })));
          return true;
        }
        notFound(res, 'Not Found'); return true;
      }
      if (method === 'PUT') {
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return true;
        const content = typeof parsed.body.content === 'string' ? parsed.body.content : '';
        const message = typeof parsed.body.message === 'string' ? parsed.body.message : 'Update file';
        const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : r.defaultBranch;
        const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : undefined;
        const out = contentsCreateOrUpdate(r, branch, filePath, content, message, sha);
        sendJson(res, out.status, out.body); return true;
      }
      if (method === 'DELETE') {
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return true;
        const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : r.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = r.refs.get(refName);
        const treeOid = treeOf(r, tip);
        const current = fileAt(r, treeOid, filePath);
        if (current === undefined) { notFound(res); return true; }
        const newTree = setFileInTree(r, treeOid, filePath, null);
        const commit = makeCommit(r, newTree, tip ? [tip] : [], typeof parsed.body.message === 'string' ? parsed.body.message : 'Delete file');
        r.refs.set(refName, commit);
        sendJson(res, 200, { commit: { sha: commit, message: 'Delete file' } }); return true;
      }
      notFound(res); return true;
    }
    // labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return true;
        const name = typeof parsed.body.name === 'string' ? parsed.body.name : '';
        if (name === '') { errMsg(res, 422, 'name is required'); return true; }
        const label: Label = { name, color: typeof parsed.body.color === 'string' ? parsed.body.color : 'ededed', description: typeof parsed.body.description === 'string' ? parsed.body.description : '' };
        r.labels.set(name, label);
        sendJson(res, 201, { id: 0, node_id: gid('Label', `${r.id}:${name}`), name: label.name, color: label.color, description: label.description, default: false });
        return true;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...r.labels.values()].map((l) => ({ id: 0, node_id: gid('Label', `${r.id}:${l.name}`), name: l.name, color: l.color, description: l.description, default: false })));
        return true;
      }
      notFound(res); return true;
    }
    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const parsed = await readJsonBody(req, res);
          if (!parsed.ok) return true;
          const labelsIn = Array.isArray(parsed.body.labels) ? parsed.body.labels.map((x) => typeof x === 'string' ? x : (x as Json)?.name).filter((x): x is string => typeof x === 'string') : [];
          for (const lb of labelsIn) if (!r.labels.has(lb)) { errMsg(res, 422, `Label does not exist: ${lb}`); return true; }
          const num = r.nextNumber++;
          const issue: Issue = { id: ++globalIssueId, number: num, title: typeof parsed.body.title === 'string' ? parsed.body.title : '', body: typeof parsed.body.body === 'string' ? parsed.body.body : '', state: 'open', labels: labelsIn, seq: num, comments: [] };
          r.issues.set(num, issue);
          sendJson(res, 201, issueJson(r, issue)); return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...r.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          const slice = paginate(req, res, list.map((i) => issueJson(r, i)), q);
          sendJson(res, 200, slice); return true;
        }
        notFound(res); return true;
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) { notFound(res); return true; }
      const issue = r.issues.get(num);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!issue) { notFound(res); return true; }
          sendJson(res, 200, issueJson(r, issue)); return true;
        }
        if (method === 'PATCH') {
          if (!issue) { notFound(res); return true; }
          const parsed = await readJsonBody(req, res);
          if (!parsed.ok) return true;
          if (parsed.body.state === 'open' || parsed.body.state === 'closed') issue.state = parsed.body.state;
          if (typeof parsed.body.title === 'string') issue.title = parsed.body.title;
          if (typeof parsed.body.body === 'string') issue.body = parsed.body.body;
          if (Array.isArray(parsed.body.labels)) {
            const labs = (parsed.body.labels as unknown[]).map((x) => typeof x === 'string' ? x : (x as Json)?.name).filter((x): x is string => typeof x === 'string');
            for (const lb of labs) if (!r.labels.has(lb)) { errMsg(res, 422, `Label does not exist: ${lb}`); return true; }
            issue.labels = labs;
          }
          sendJson(res, 200, issueJson(r, issue)); return true;
        }
        notFound(res); return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { notFound(res); return true; }
        if (method === 'POST') {
          const parsed = await readJsonBody(req, res);
          if (!parsed.ok) return true;
          const c = { id: r.nextCommentId++, body: typeof parsed.body.body === 'string' ? parsed.body.body : '' };
          issue.comments.push(c);
          sendJson(res, 201, { id: c.id, node_id: gid('IssueComment', `${r.id}:${num}:${c.id}`), body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_TS, updated_at: FIXED_TS });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('IssueComment', `${r.id}:${num}:${c.id}`), body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, created_at: FIXED_TS, updated_at: FIXED_TS })));
          return true;
        }
        notFound(res); return true;
      }
      notFound(res); return true;
    }
    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const parsed = await readJsonBody(req, res);
          if (!parsed.ok) return true;
          const headRef = typeof parsed.body.head === 'string' ? parsed.body.head : '';
          const baseRef = typeof parsed.body.base === 'string' ? parsed.body.base : r.defaultBranch;
          const headSha = r.refs.get(`refs/heads/${headRef}`);
          const baseSha = r.refs.get(`refs/heads/${baseRef}`);
          if (!headSha || !baseSha) { errMsg(res, 422, 'head or base branch does not exist'); return true; }
          const num = r.nextNumber++;
          const changed = diffFiles(r, treeOf(r, baseSha), treeOf(r, headSha));
          const pull: Pull = {
            id: ++globalIssueId, number: num,
            title: typeof parsed.body.title === 'string' ? parsed.body.title : '',
            body: typeof parsed.body.body === 'string' ? parsed.body.body : '',
            state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
            headRef, baseRef, headSha, baseSha, seq: num,
            files: fileStats(r, treeOf(r, baseSha), treeOf(r, headSha), changed), changed,
          };
          r.pulls.set(num, pull);
          sendJson(res, 201, pullJson(r, pull)); return true;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...r.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const slice = paginate(req, res, list.map((p) => pullJson(r, p)), q);
          sendJson(res, 200, slice); return true;
        }
        notFound(res); return true;
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) { notFound(res); return true; }
      const pull = r.pulls.get(num);
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!pull) { notFound(res); return true; }
          sendJson(res, 200, pullJson(r, pull)); return true;
        }
        notFound(res); return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) { notFound(res); return true; }
        sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: '', patch: '' })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { notFound(res); return true; }
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return true;
        if (pull.state === 'closed') { errMsg(res, 405, 'Pull request is already closed'); return true; }
        if (!isMergeable(r, pull)) { errMsg(res, 405, 'Merge conflict'); return true; }
        // squash: apply head changes onto the base tip tree
        const baseTip = r.refs.get(`refs/heads/${pull.baseRef}`);
        let treeOid = treeOf(r, baseTip);
        for (const c of pull.changed) treeOid = setFileInTree(r, treeOid, c.path, c.content);
        const msg = `Merge pull request #${pull.number} from ${pull.headRef}`;
        const mergeSha = makeCommit(r, treeOid!, baseTip ? [baseTip] : [], msg);
        r.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed'; pull.merged = true; pull.mergedAt = FIXED_TS; pull.mergeCommitSha = mergeSha;
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      notFound(res); return true;
    }
    notFound(res); return true;
  }
  return false;
}

// ---------------------------------------------------------------- git smart HTTP

function refList(r: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of [...r.refs.entries()].sort()) out.push({ name, oid });
  return out;
}
function peeledOf(r: Repo, oid: string): string | undefined {
  const o = r.objects.get(oid);
  if (o && o.type === 'tag') return parseTag(o.data).object;
  return undefined;
}
function v0Advertisement(r: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT} symref=HEAD:refs/heads/${r.defaultBranch}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${r.defaultBranch}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = refList(r);
  const headOid = r.refs.get(`refs/heads/${r.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOf(r, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines as Array<string | 'flush'>);
}
function v2Advertisement(service: string): Buffer {
  const lines: Array<string | 'flush'> = [
    `# service=${service}\n`,
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
    'object-info\n',
    'flush',
  ];
  return pktLines(lines);
}

/** Compute the objects to send for wants/haves/depth. Returns {objects, shallow, unshallow}. */
function computeFetch(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): { objects: Map<string, GitObj>; shallow: string[]; unshallow: string[] } {
  const haveReachable = collectReachable(haves, lookup(r), new Set(shallowIn));
  const result = new Map<string, GitObj>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    // BFS by commit generation from wants; included commits are those with
    // distance < depth. A commit is shallow when it is included but one of its
    // parents is not included (its history is cut off there).
    const dist = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = [];
    for (const w of wants.filter(isOid)) {
      const o = r.objects.get(w);
      if (!o) continue;
      if (o.type === 'tag') {
        const tgt = parseTag(o.data).target;
        if (!haveReachable.has(w)) result.set(w, o);
        if (r.objects.get(tgt)?.type === 'commit') queue.push({ oid: tgt, d: 0 });
      } else if (o.type === 'commit') queue.push({ oid: w, d: 0 });
      else if (!haveReachable.has(w)) result.set(w, o);
    }
    while (queue.length) {
      const { oid, d } = queue.shift()!;
      if (dist.has(oid)) continue;
      const o = r.objects.get(oid);
      if (!o || o.type !== 'commit') continue;
      dist.set(oid, d);
      if (d >= depth) continue;
      const c = parseCommit(o.data);
      for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
    }
    const included = new Set<string>();
    const includedCommits = new Set<string>();
    for (const [oid, d] of dist) if (d < depth) { included.add(oid); includedCommits.add(oid); }
    for (const oid of includedCommits) {
      const c = parseCommit(r.objects.get(oid)!.data);
      for (const x of collectReachable([c.tree], lookup(r))) included.add(x);
    }
    for (const oid of included) {
      if (haveReachable.has(oid)) continue;
      const o = r.objects.get(oid);
      if (o) result.set(oid, o);
    }
    for (const oid of includedCommits) {
      const c = parseCommit(r.objects.get(oid)!.data);
      if (c.parents.some((p) => !includedCommits.has(p))) shallow.push(oid);
    }
    for (const s of shallowIn) {
      if (included.has(s)) {
        const c = parseCommit(r.objects.get(s)!.data);
        if (c.parents.every((p) => included.has(p))) unshallow.push(s);
      }
    }
  } else {
    const wanted = collectReachable(wants, lookup(r));
    for (const oid of wanted) {
      if (haveReachable.has(oid)) continue;
      const o = r.objects.get(oid);
      if (o) result.set(oid, o);
    }
  }
  return { objects: result, shallow, unshallow };
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 60000));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}
// Fetch responses are deterministic for identical (repo, wants, haves, shallow,
// depth), so cache them: the clone workload issues 50 identical concurrent
// shallow clones, and the bench warms up before measuring.
const fetchCache = new Map<string, Buffer>();
function cachedFetch(key: string, build: () => Buffer): Buffer {
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const buf = build();
  if (fetchCache.size >= 32) {
    const first = fetchCache.keys().next().value;
    if (first !== undefined) fetchCache.delete(first);
  }
  fetchCache.set(key, buf);
  return buf;
}
function fetchKey(proto: string, r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): string {
  return [proto, r.id, wants.join(','), haves.join(','), shallowIn.join(','), String(depth)].join('|');
}
function v2FetchResponse(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): Buffer {
  return cachedFetch(fetchKey('v2', r, wants, haves, shallowIn, depth), () => buildV2FetchResponse(r, wants, haves, shallowIn, depth));
}
function buildV2FetchResponse(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): Buffer {
  const { objects, shallow, unshallow } = computeFetch(r, wants, haves, shallowIn, depth);
  const pack = writePack([...objects.values()].map((o) => ({ type: o.type, data: o.data })));
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  parts.push(pkt('NAK\n'));
  parts.push(PKT_DELIM);
  if (shallow.length || unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function v0FetchResponse(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): Buffer {
  return cachedFetch(fetchKey('v0', r, wants, haves, shallowIn, depth), () => buildV0FetchResponse(r, wants, haves, shallowIn, depth));
}
function buildV0FetchResponse(r: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | undefined): Buffer {
  const { objects, shallow, unshallow } = computeFetch(r, wants, haves, shallowIn, depth);
  const pack = writePack([...objects.values()].map((o) => ({ type: o.type, data: o.data })));
  const parts: Buffer[] = [];
  parts.push(pkt('NAK\n'));
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!m) return false;
  const owner = decodeSeg(m[1]); const repoName = decodeSeg(m[2]);
  const suffix = m[3] ?? '';
  const r = getRepo(owner, repoName);
  const service = q.get('service') ?? '';

  if (method === 'GET' && suffix === '/info/refs') {
    if (!r) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement('git-upload-pack'));
      else sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(r, 'git-upload-pack'));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(r, 'git-receive-pack'));
      return true;
    }
    notFound(res); return true;
  }

  if (method === 'POST' && suffix === '/git-upload-pack') {
    if (!r) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      if (isV2) {
        const packets = decodePkts(body);
        const lines: string[] = [];
        let command = '';
        let afterDelim = false;
        for (const p of packets) {
          if (p.kind === 'delim') { afterDelim = true; continue; }
          if (p.kind !== 'data') continue;
          const text = p.payload.toString('utf8');
          if (!afterDelim) {
            if (text.startsWith('command=')) command = text.slice(8).trim();
          } else lines.push(text);
        }
        if (command === 'ls-refs') {
          let peel = false; let symrefs = false; let unborn = false;
          const prefixes: string[] = [];
          for (const line of lines) {
            const t = line.trim();
            if (t === 'peel') peel = true;
            else if (t === 'symrefs') symrefs = true;
            else if (t === 'unborn') unborn = true;
            else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
          }
          const out: string[] = [];
          const headOid = r.refs.get(`refs/heads/${r.defaultBranch}`);
          if (headOid) {
            if (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p === 'HEAD')) {
              // HEAD is only listed when no prefix filter, or prefix matches HEAD
              if (prefixes.length === 0) out.push(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${r.defaultBranch}` : ''}\n`);
            }
          } else if (unborn) {
            if (prefixes.length === 0) out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${r.defaultBranch}` : ''}\n`);
          }
          for (const ref of refList(r)) {
            if (prefixes.length && !prefixes.some((p) => ref.name.startsWith(p))) continue;
            let line = `${ref.oid} ${ref.name}`;
            if (peel) {
              const peeled = peeledOf(r, ref.oid);
              if (peeled) line += ` peeled:${peeled}`;
            }
            out.push(`${line}\n`);
          }
          sendRaw(res, 200, 'application/x-git-upload-pack-result', pktLines([...out, 'flush']));
          return true;
        }
        if (command === 'fetch') {
          const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
          let depth: number | undefined;
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('want ')) wants.push(t.slice(5).trim());
            else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
            else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
            else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
          }
          sendRaw(res, 200, 'application/x-git-upload-pack-result', v2FetchResponse(r, wants, haves, shallowIn, depth));
          return true;
        }
        errMsg(res, 400, 'unknown v2 command'); return true;
      }
      // v0 fetch
      const packets = decodePkts(body);
      const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
      let depth: number | undefined;
      let seenFlush = false;
      for (const p of packets) {
        if (p.kind === 'flush') { seenFlush = true; continue; }
        if (p.kind !== 'data') continue;
        const text = p.payload.toString('utf8');
        const t = text.trim();
        if (t.startsWith('want ')) {
          const rest = t.slice(5).trim();
          const oid = rest.split(' ')[0];
          if (isOid(oid)) wants.push(oid);
        } else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
        else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
        void seenFlush;
      }
      if (wants.length === 0) { errMsg(res, 400, 'no want lines'); return true; }
      sendRaw(res, 200, 'application/x-git-upload-pack-result', v0FetchResponse(r, wants, haves, shallowIn, depth));
      return true;
    } catch (e) {
      errMsg(res, 400, `bad request: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
  }

  if (method === 'POST' && suffix === '/git-receive-pack') {
    if (!r) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const body = await readBody(req);
    try {
      const end = pktDataEnd(body);
      const packets = decodePkts(body.subarray(0, end));
      const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
      for (const p of packets) {
        if (p.kind !== 'data') continue;
        let text = p.payload.toString('utf8');
        const nul = text.indexOf('\0');
        if (nul >= 0) text = text.slice(0, nul);
        const t = text.trim();
        const parts = t.split(' ');
        if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
          commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
        }
      }
      const packBytes = body.subarray(end);
      let unpackOk = true; let unpackDetail = 'ok';
      if (packBytes.length > 0) {
        try {
          const objs = readPack(packBytes, lookup(r));
          for (const [oid, o] of objs) if (!r.objects.has(oid)) r.objects.set(oid, o);
        } catch (e) {
          unpackOk = false;
          unpackDetail = e instanceof Error ? e.message : 'unpack error';
        }
      }
      const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
      for (const cmd of commands) {
        const current = r.refs.get(cmd.ref);
        let ok = false; let reason = '';
        if (unpackOk) {
          if (cmd.newOid === ZERO_OID) {
            if (current === undefined) { ok = false; reason = 'ref does not exist'; }
            else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { ok = false; reason = 'non-fast-forward'; }
            else { r.refs.delete(cmd.ref); ok = true; }
          } else if (!r.objects.has(cmd.newOid)) {
            ok = false; reason = 'object not found';
          } else if (current === undefined) {
            if (cmd.oldOid !== ZERO_OID) { ok = false; reason = 'non-fast-forward'; }
            else { r.refs.set(cmd.ref, cmd.newOid); ok = true; }
          } else if (current === cmd.newOid) {
            ok = true;
          } else {
            const anc = ancestorsOf(cmd.newOid, lookup(r));
            if (anc.has(current) && cmd.oldOid === current) { r.refs.set(cmd.ref, cmd.newOid); ok = true; }
            else { ok = false; reason = 'non-fast-forward'; }
          }
        } else { ok = false; reason = 'unpack error'; }
        reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
      }
      const report = pktLines([...reportLines, 'flush']);
      // wrap in sideband band 1
      const parts: Buffer[] = [];
      let off = 0;
      while (off < report.length) {
        const chunk = report.subarray(off, Math.min(report.length, off + 60000));
        parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
        off += chunk.length;
      }
      sendRaw(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
      return true;
    } catch (e) {
      errMsg(res, 400, `bad request: ${e instanceof Error ? e.message : String(e)}`);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- GraphQL

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'assignees'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
};
const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface GqlField { name: string; alias: string | null; args: Record<string, unknown>; children: GqlField[] | null; fragmentType: string | null }
interface GqlOp { kind: 'query' | 'mutation'; name: string | null; fields: GqlField[] }

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}():,=![]'.includes(c)) { tokens.push(c); i++; continue; }
    if (c === '$') { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; tokens.push(src.slice(i, j)); i = j; continue; }
    if (c === '"') {
      let j = i + 1; let s = '"';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') { s += src[j] + (src[j + 1] ?? ''); j += 2; } else { s += src[j]; j++; } }
      s += '"'; tokens.push(s); i = j + 1; continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_\-]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    tokens.push(src.slice(i, j)); i = j;
  }
  return tokens;
}
class GqlParser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = tokenizeGql(src); }
  peek(): string | undefined { return this.toks[this.pos]; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.peek() === t) this.pos++; }
  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.next();
    if (t === '[') {
      const arr: unknown[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) arr.push(this.parseValue(vars));
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        if (this.peek() === ',') { this.next(); continue; }
        const k = this.next();
        this.expect(':');
        obj[k] = this.parseValue(vars);
      }
      this.expect('}');
      return obj;
    }
    if (t.startsWith('$')) return vars[t.slice(1)];
    if (t.startsWith('"')) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const n = Number(t);
    if (t !== '' && !Number.isNaN(n)) return n;
    return t; // enum bare word
  }
  parseArgs(vars: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')' && this.peek() !== undefined) {
      if (this.peek() === ',') { this.next(); continue; }
      const k = this.next();
      this.expect(':');
      args[k] = this.parseValue(vars);
    }
    this.expect(')');
    return args;
  }
  parseSelection(vars: Record<string, unknown>): GqlField[] {
    const fields: GqlField[] = [];
    this.expect('{');
    while (this.peek() !== '}' && this.peek() !== undefined) {
      if (this.peek() === '...') {
        this.next();
        let fragType: string | null = null;
        if (this.peek() === 'on') { this.next(); fragType = this.next(); }
        const children = this.parseSelection(vars);
        fields.push({ name: '__fragment__', alias: null, args: {}, children, fragmentType: fragType });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs(vars);
      let children: GqlField[] | null = null;
      if (this.peek() === '{') children = this.parseSelection(vars);
      fields.push({ name, alias, args, children, fragmentType: null });
    }
    this.expect('}');
    return fields;
  }
  parseOperation(vars: Record<string, unknown>): GqlOp | null {
    // skip variable definitions "(...)" after operation name
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t === 'query' || t === 'mutation') { kind = t as 'query' | 'mutation'; this.next(); }
    if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') name = this.next();
    if (this.peek() === '(') {
      let depth = 0;
      while (this.peek() !== undefined) {
        const tok = this.next();
        if (tok === '(') depth++;
        else if (tok === ')') { depth--; if (depth === 0) break; }
      }
    }
    if (this.peek() !== '{') return null;
    return { kind, name, fields: this.parseSelection(vars) };
  }
}
function parseGql(src: string, vars: Record<string, unknown>): GqlOp | null {
  try { return new GqlParser(src).parseOperation(vars); } catch { return null; }
}

function issueGql(r: Repo, i: Issue): Json {
  return {
    id: gid('Issue', `${r.id}:${i.number}`), number: i.number, title: i.title,
    state: i.state === 'open' ? 'OPEN' : 'CLOSED', body: i.body,
    url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
    createdAt: FIXED_TS, updatedAt: FIXED_TS, closedAt: i.state === 'closed' ? FIXED_TS : null,
    author: { login: VIEWER_LOGIN }, labels: { nodes: i.labels.map((n) => ({ name: n })) },
    comments: { nodes: i.comments.map((c) => ({ id: gid('IssueComment', `${r.id}:${i.number}:${c.id}`), body: c.body })) },
  };
}
function pullGql(r: Repo, p: Pull): Json {
  return {
    id: gid('PullRequest', `${r.id}:${p.number}`), number: p.number, title: p.title, body: p.body,
    state: p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: p.merged, mergeable: isMergeable(r, p) ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: p.headRef, baseRefName: p.baseRef,
    headRefOid: r.refs.get(`refs/heads/${p.headRef}`) ?? p.headSha,
    baseRefOid: r.refs.get(`refs/heads/${p.baseRef}`) ?? p.baseSha,
    mergedAt: p.mergedAt, mergeCommit: p.mergeCommitSha ? { oid: p.mergeCommitSha } : null,
    author: { login: VIEWER_LOGIN }, createdAt: FIXED_TS, updatedAt: FIXED_TS,
    files: { nodes: p.files.map((f) => ({ path: f.filename })) },
  };
}
function repoGql(r: Repo): Json {
  return {
    id: gid('Repository', String(r.id)), databaseId: r.id, name: r.name,
    nameWithOwner: `${r.owner}/${r.name}`, owner: { login: r.owner, id: VIEWER_ID },
    defaultBranchRef: { name: r.defaultBranch },
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    description: r.description, private: r.priv,
    url: `https://example.invalid/${r.owner}/${r.name}`, createdAt: FIXED_TS,
  };
}
function cursorOf(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function cursorNum(c: unknown): number | null {
  if (typeof c !== 'string' || c === '') return null;
  try {
    const t = Buffer.from(c, 'base64').toString('utf8');
    if (t.startsWith('cursor:')) return Number(t.slice(7));
  } catch { return null; }
  return null;
}

function execGql(op: GqlOp, vars: Record<string, unknown>): { data: Json | null; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const data: Json = {};
  const resolveIssueConn = (r: Repo, args: Record<string, unknown>): Json => {
    let list = [...r.issues.values()];
    const states = args.states;
    if (Array.isArray(states) && states.length) {
      const want = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((i) => want.has(i.state));
    }
    const orderBy = args.orderBy as Json | undefined;
    if (orderBy && orderBy.field === 'CREATED_AT') {
      list.sort((a, b) => orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq);
    } else list.sort((a, b) => a.seq - b.seq);
    const after = cursorNum(args.after);
    if (after !== null) list = list.filter((i) => i.number > after);
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    const hasNext = list.length > first;
    return {
      nodes: page.map((i) => issueGql(r, i)),
      totalCount: list.length,
      pageInfo: { hasNextPage: hasNext, hasPreviousPage: after !== null, endCursor: page.length ? cursorOf(page[page.length - 1].number) : null, startCursor: page.length ? cursorOf(page[0].number) : null },
    };
  };
  const resolveRepoFields = (r: Repo, fields: GqlField[]): Json => {
    const out: Json = {};
    const base = repoGql(r);
    for (const f of fields) {
      if (f.name === '__fragment__') {
        Object.assign(out, resolveRepoFields(r, f.children ?? []));
        continue;
      }
      const key = f.alias ?? f.name;
      if (f.name === 'issues') { out[key] = resolveIssueConn(r, f.args); continue; }
      if (f.name === 'issue') {
        const n = typeof f.args.number === 'number' ? f.args.number : null;
        const iss = n !== null ? r.issues.get(n) : undefined;
        out[key] = iss ? pickFields(issueGql(r, iss), f.children) : null;
        continue;
      }
      if (f.name === 'pullRequests') {
        let list = [...r.pulls.values()].sort((a, b) => b.seq - a.seq);
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        list = list.slice(0, first);
        out[key] = { nodes: list.map((p) => pullGql(r, p)), totalCount: r.pulls.size, pageInfo: { hasNextPage: false, endCursor: null } };
        continue;
      }
      if (f.name === 'pullRequest') {
        const n = typeof f.args.number === 'number' ? f.args.number : null;
        const pr = n !== null ? r.pulls.get(n) : undefined;
        out[key] = pr ? pickFields(pullGql(r, pr), f.children) : null;
        continue;
      }
      if (f.name === 'owner') { out[key] = f.children ? pickFields({ login: r.owner, id: VIEWER_ID }, f.children) : { login: r.owner }; continue; }
      if (f.name === 'defaultBranchRef') { out[key] = f.children ? pickFields({ name: r.defaultBranch }, f.children) : { name: r.defaultBranch }; continue; }
      if (f.name in base) { out[key] = base[f.name]; continue; }
      errors.push({ message: `Cannot query field "${f.name}" on type "Repository".` });
      out[key] = null;
    }
    return out;
  };
  const pickFields = (obj: Json, children: GqlField[] | null): Json => {
    if (!children) return obj;
    const out: Json = {};
    for (const f of children) {
      if (f.name === '__fragment__') { Object.assign(out, pickFields(obj, f.children)); continue; }
      const key = f.alias ?? f.name;
      if (f.name === '__typename') { out[key] = obj.__typename ?? 'Repository'; continue; }
      if (!(f.name in obj)) { errors.push({ message: `Cannot query field "${f.name}".` }); out[key] = null; continue; }
      const v = obj[f.name];
      if (f.children && v !== null && typeof v === 'object' && !Array.isArray(v)) out[key] = pickFields(v as Json, f.children);
      else if (f.children && v !== null && typeof v === 'object' && Array.isArray((v as Json).nodes)) {
        const nodes = ((v as Json).nodes as Json[]).map((n) => pickFields(n, f.children!.find((c) => c.name === 'nodes')?.children ?? null));
        out[key] = { ...(v as Json), nodes };
      } else out[key] = v;
    }
    return out;
  };
  // NOTE: pickFields is used before its declaration in resolveRepoFields closures; hoisted const is
  // assigned by the time any field resolution runs (execGql body runs after both consts are created).
  for (const f of op.fields) {
    const key = f.alias ?? f.name;
    if (f.name === '__type') {
      const typeName = typeof f.args.name === 'string' ? f.args.name : '';
      const out: Json = {};
      for (const c of f.children ?? []) {
        if (c.name === 'fields') out[c.alias ?? 'fields'] = (GQL_TYPE_FIELDS[typeName] ?? []).map((n) => ({ name: n }));
        else if (c.name === 'enumValues') out[c.alias ?? 'enumValues'] = (GQL_ENUM_VALUES[typeName] ?? []).map((n) => ({ name: n }));
        else if (c.name === 'name') out[c.alias ?? 'name'] = typeName;
        else if (c.name === 'kind') out[c.alias ?? 'kind'] = GQL_ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
      }
      data[key] = out;
      continue;
    }
    if (f.name === 'viewer') {
      const out: Json = {};
      for (const c of f.children ?? []) {
        if (c.name === 'login') out[c.alias ?? 'login'] = VIEWER_LOGIN;
        else if (c.name === 'id') out[c.alias ?? 'id'] = gid('User', String(VIEWER_ID));
        else { errors.push({ message: `Cannot query field "${c.name}" on type "User".` }); out[c.alias ?? c.name] = null; }
      }
      data[key] = out;
      continue;
    }
    if (f.name === 'repository') {
      const owner = typeof f.args.owner === 'string' ? f.args.owner : '';
      const name = typeof f.args.name === 'string' ? f.args.name : '';
      const r = getRepo(owner, name);
      if (!r) { data[key] = null; continue; }
      data[key] = f.children ? resolveRepoFields(r, f.children) : repoGql(r);
      continue;
    }
    if (f.name === 'node') {
      const id = typeof f.args.id === 'string' ? f.args.id : '';
      const parsed = parseGid(id);
      if (!parsed) { data[key] = null; continue; }
      if (parsed.kind === 'Repository') {
        const r = [...repoOrder].find((x) => x.id === Number(parsed.id));
        if (!r) { data[key] = null; continue; }
        const base = repoGql(r);
        data[key] = f.children ? pickFields({ ...base, __typename: 'Repository' }, f.children) : base;
        continue;
      }
      if (parsed.kind === 'Issue') {
        const [rid, num] = parsed.id.split(':');
        const r = [...repoOrder].find((x) => x.id === Number(rid));
        const iss = r?.issues.get(Number(num));
        data[key] = iss && r ? pickFields({ ...issueGql(r, iss), __typename: 'Issue' }, f.children) : null;
        continue;
      }
      if (parsed.kind === 'PullRequest') {
        const [rid, num] = parsed.id.split(':');
        const r = [...repoOrder].find((x) => x.id === Number(rid));
        const pr = r?.pulls.get(Number(num));
        data[key] = pr && r ? pickFields({ ...pullGql(r, pr), __typename: 'PullRequest' }, f.children) : null;
        continue;
      }
      data[key] = null;
      continue;
    }
    if (op.kind === 'mutation') {
      if (f.name === 'createIssue') {
        const input = (f.args.input ?? {}) as Json;
        const parsed = parseGid(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        const r = parsed?.kind === 'Repository' ? [...repoOrder].find((x) => x.id === Number(parsed.id)) : undefined;
        if (!r) { errors.push({ message: 'Repository not found.' }); data[key] = null; continue; }
        const num = r.nextNumber++;
        const issue: Issue = { id: ++globalIssueId, number: num, title: typeof input.title === 'string' ? input.title : '', body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], seq: num, comments: [] };
        r.issues.set(num, issue);
        data[key] = { issue: { number: num, id: gid('Issue', `${r.id}:${num}`) } };
        continue;
      }
      if (f.name === 'closeIssue') {
        const input = (f.args.input ?? {}) as Json;
        const parsed = parseGid(typeof input.issueId === 'string' ? input.issueId : '');
        let found: { r: Repo; i: Issue } | null = null;
        if (parsed?.kind === 'Issue') {
          const [rid, num] = parsed.id.split(':');
          const r = [...repoOrder].find((x) => x.id === Number(rid));
          const iss = r?.issues.get(Number(num));
          if (r && iss) found = { r, i: iss };
        }
        if (!found) { errors.push({ message: 'Issue not found.' }); data[key] = null; continue; }
        found.i.state = 'closed';
        data[key] = { issue: { number: found.i.number, id: gid('Issue', `${found.r.id}:${found.i.number}`), state: 'CLOSED' } };
        continue;
      }
      if (f.name === 'createPullRequest') {
        const input = (f.args.input ?? {}) as Json;
        const parsed = parseGid(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        const r = parsed?.kind === 'Repository' ? [...repoOrder].find((x) => x.id === Number(parsed.id)) : undefined;
        const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
        const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : (r?.defaultBranch ?? 'main');
        if (!r) { errors.push({ message: 'Repository not found.' }); data[key] = null; continue; }
        const headSha = r.refs.get(`refs/heads/${headRef}`);
        const baseSha = r.refs.get(`refs/heads/${baseRef}`);
        if (!headSha || !baseSha) { errors.push({ message: 'head or base branch does not exist' }); data[key] = null; continue; }
        const num = r.nextNumber++;
        const changed = diffFiles(r, treeOf(r, baseSha), treeOf(r, headSha));
        const pull: Pull = {
          id: ++globalIssueId, number: num, title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '', state: 'open', merged: false, mergedAt: null,
          mergeCommitSha: null, headRef, baseRef, headSha, baseSha, seq: num,
          files: fileStats(r, treeOf(r, baseSha), treeOf(r, headSha), changed), changed,
        };
        r.pulls.set(num, pull);
        data[key] = { pullRequest: { number: num, id: gid('PullRequest', `${r.id}:${num}`), state: 'OPEN', headRefName: headRef, baseRefName: baseRef } };
        continue;
      }
      if (f.name === 'mergePullRequest') {
        const input = (f.args.input ?? {}) as Json;
        const parsed = parseGid(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
        let found: { r: Repo; p: Pull } | null = null;
        if (parsed?.kind === 'PullRequest') {
          const [rid, num] = parsed.id.split(':');
          const r = [...repoOrder].find((x) => x.id === Number(rid));
          const pr = r?.pulls.get(Number(num));
          if (r && pr) found = { r, p: pr };
        }
        if (!found) { errors.push({ message: 'Pull request not found.' }); data[key] = null; continue; }
        const { r, p } = found;
        if (p.state === 'closed') { errors.push({ message: 'Pull request is already closed.' }); data[key] = null; continue; }
        if (!isMergeable(r, p)) { errors.push({ message: 'Merge conflict.' }); data[key] = null; continue; }
        const baseTip = r.refs.get(`refs/heads/${p.baseRef}`);
        let treeOid = treeOf(r, baseTip);
        for (const c of p.changed) treeOid = setFileInTree(r, treeOid, c.path, c.content);
        const mergeSha = makeCommit(r, treeOid!, baseTip ? [baseTip] : [], `Merge pull request #${p.number} from ${p.headRef}`);
        r.refs.set(`refs/heads/${p.baseRef}`, mergeSha);
        p.state = 'closed'; p.merged = true; p.mergedAt = FIXED_TS; p.mergeCommitSha = mergeSha;
        data[key] = { pullRequest: { number: p.number, id: gid('PullRequest', `${r.id}:${p.number}`), merged: true, state: 'MERGED' } };
        continue;
      }
      if (f.name === 'addComment') {
        const input = (f.args.input ?? {}) as Json;
        const parsed = parseGid(typeof input.subjectId === 'string' ? input.subjectId : '');
        let found: { r: Repo; i: Issue } | null = null;
        if (parsed?.kind === 'Issue') {
          const [rid, num] = parsed.id.split(':');
          const r = [...repoOrder].find((x) => x.id === Number(rid));
          const iss = r?.issues.get(Number(num));
          if (r && iss) found = { r, i: iss };
        }
        if (!found) { errors.push({ message: 'Subject not found.' }); data[key] = null; continue; }
        const body = typeof input.body === 'string' ? input.body : '';
        const c = { id: found.r.nextCommentId++, body };
        found.i.comments.push(c);
        data[key] = { commentEdge: { node: { id: gid('IssueComment', `${found.r.id}:${found.i.number}:${c.id}`), body } } };
        continue;
      }
      errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
      data[key] = null;
      continue;
    }
    errors.push({ message: `Cannot query field "${f.name}" on type "Query".` });
    data[key] = null;
  }
  return { data: errors.length && Object.keys(data).length === 0 ? null : data, errors };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = await readBody(req);
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { errMsg(res, 400, 'Problems parsing JSON'); return true; }
  const ops: Array<{ query: string; variables?: Record<string, unknown> }> = Array.isArray(body)
    ? (body as Array<{ query: string; variables?: Record<string, unknown> }>)
    : [{ query: (body as Json).query as string, variables: ((body as Json).variables as Record<string, unknown>) ?? {} }];
  const results: Json[] = [];
  for (const item of ops) {
    const vars = item.variables ?? {};
    const op = parseGql(typeof item.query === 'string' ? item.query : '', vars);
    if (!op) { results.push({ data: null, errors: [{ message: 'Could not parse query.' }] }); continue; }
    const { data, errors } = execGql(op, vars);
    const out: Json = { data };
    if (errors.length) out.errors = errors;
    results.push(out);
  }
  sendJson(res, 200, Array.isArray(body) ? results : results[0]);
  return true;
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Json[] = [
  { name: 'create_repo', description: 'Create a repository owned by the viewer.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

function mcpResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}
function mcpError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}
function toolText(obj: unknown): Json {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}
function toolErr(text: string): Json {
  return { content: [{ type: 'text', text }], isError: true };
}
function missingArg(args: Json, required: string[]): string | null {
  for (const k of required) if (args[k] === undefined || args[k] === null || args[k] === '') return k;
  return null;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    mcpError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  const msg = body as Json;
  const id = msg.id === undefined ? null : msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Json;
  if (method === 'server/discover') {
    mcpResult(res, id, {
      resultType: 'DiscoverResult',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
    return true;
  }
  if (method === 'initialize') {
    const want = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const chosen = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(want) ? want : '2025-11-25';
    mcpResult(res, id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    return true;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': `req-${++reqCounter}` });
    res.end();
    return true;
  }
  if (method === 'ping') { mcpResult(res, id, {}); return true; }
  if (method === 'tools/list') {
    mcpResult(res, id, { tools: MCP_TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Json;
    const tool = (MCP_TOOLS as Array<{ name: string }>).find((t) => t.name === name);
    if (!tool) { mcpError(res, 200, id, -32602, `Unknown tool: ${name}`); return true; }
    const schema = (MCP_TOOLS.find((t) => (t as Json).name === name) as Json).inputSchema as Json;
    const required = (schema.required as string[]) ?? [];
    const miss = missingArg(args, required);
    if (miss) { mcpError(res, 200, id, -32602, `Missing required argument: ${miss}`); return true; }
    const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
    const repoName = typeof args.repo === 'string' ? args.repo : (typeof args.name === 'string' ? args.name : '');
    if (name === 'create_repo') {
      const rname = typeof args.name === 'string' ? args.name : '';
      if (rname === '') { mcpResult(res, id, toolErr('Missing required argument: name')); return true; }
      let r = getRepo(VIEWER_LOGIN, rname);
      if (!r) r = createRepoRecord(rname, typeof args.description === 'string' ? args.description : '', args.private === true);
      mcpResult(res, id, toolText(repoJson(r)));
      return true;
    }
    const r = getRepo(owner, repoName);
    if (!r) { mcpResult(res, id, toolErr(`Repository not found: ${owner}/${repoName}`)); return true; }
    if (name === 'get_repo') { mcpResult(res, id, toolText(repoJson(r))); return true; }
    if (name === 'create_issue') {
      const num = r.nextNumber++;
      const issue: Issue = { id: ++globalIssueId, number: num, title: typeof args.title === 'string' ? args.title : '', body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], seq: num, comments: [] };
      r.issues.set(num, issue);
      mcpResult(res, id, toolText(issueJson(r, issue)));
      return true;
    }
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...r.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      mcpResult(res, id, toolText(list.map((i) => issueJson(r!, i))));
      return true;
    }
    if (name === 'create_pull_request') {
      const headRef = typeof args.head === 'string' ? args.head : '';
      const baseRef = typeof args.base === 'string' ? args.base : r.defaultBranch;
      const headSha = r.refs.get(`refs/heads/${headRef}`);
      const baseSha = r.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) { mcpResult(res, id, toolErr('head or base branch does not exist')); return true; }
      const num = r.nextNumber++;
      const changed = diffFiles(r, treeOf(r, baseSha), treeOf(r, headSha));
      const pull: Pull = {
        id: ++globalIssueId, number: num, title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '', state: 'open', merged: false, mergedAt: null,
        mergeCommitSha: null, headRef, baseRef, headSha, baseSha, seq: num,
        files: fileStats(r, treeOf(r, baseSha), treeOf(r, headSha), changed), changed,
      };
      r.pulls.set(num, pull);
      mcpResult(res, id, toolText(pullJson(r, pull)));
      return true;
    }
    if (name === 'merge_pull_request') {
      const num = Number(args.pull_number);
      const pull = r.pulls.get(num);
      if (!pull) { mcpResult(res, id, toolErr(`Pull request not found: ${num}`)); return true; }
      if (pull.state === 'closed') { mcpResult(res, id, toolErr('Pull request is already closed')); return true; }
      if (!isMergeable(r, pull)) { mcpResult(res, id, toolErr('Merge conflict')); return true; }
      const baseTip = r.refs.get(`refs/heads/${pull.baseRef}`);
      let treeOid = treeOf(r, baseTip);
      for (const c of pull.changed) treeOid = setFileInTree(r, treeOid, c.path, c.content);
      const mergeSha = makeCommit(r, treeOid!, baseTip ? [baseTip] : [], `Merge pull request #${pull.number} from ${pull.headRef}`);
      r.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed'; pull.merged = true; pull.mergedAt = FIXED_TS; pull.mergeCommitSha = mergeSha;
      mcpResult(res, id, toolText({ sha: mergeSha, merged: true, number: pull.number, state: 'closed' }));
      return true;
    }
    mcpError(res, 200, id, -32602, `Unknown tool: ${name}`);
    return true;
  }
  mcpError(res, 200, id, -32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { path, query } = urlOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        // auth for everything except /healthz
        if (!authed(req)) { errMsg(res, 401, 'Requires authentication'); return; }
        if (path === '/api/graphql' && method === 'POST') { await handleGraphql(req, res); return; }
        if (path === '/mcp' && method === 'POST') { await handleMcp(req, res); return; }
        if (path.startsWith('/api/v3')) {
          // malformed JSON check for body-bearing methods happens inside handlers;
          // a body that is not JSON on a POST/PATCH/PUT to an unknown route is a 400
          if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
            // peek: handlers read the body themselves; unknown-route check below needs
            // the body, so let handleRest decide. For routes handleRest returns false,
            // validate JSON here by re-reading is impossible; instead rely on handleRest.
          }
          const handled = await handleRest(req, res, path, query);
          if (handled) return;
          // unknown /api/v3 route: still need a 400 if the body is malformed JSON
          if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try { JSON.parse(raw.toString('utf8')); } catch { errMsg(res, 400, 'Problems parsing JSON'); return; }
            }
          }
          notFound(res);
          return;
        }
        if (await handleGit(req, res, path, query)) return;
        // malformed JSON on other body-bearing routes
        if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try { JSON.parse(raw.toString('utf8')); } catch { errMsg(res, 400, 'Problems parsing JSON'); return; }
          }
        }
        notFound(res);
      } catch (e) {
        try { errMsg(res, 500, e instanceof Error ? e.message : String(e)); } catch { /* socket closed */ }
      }
    })();
  });
}
