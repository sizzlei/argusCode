// Converts MongoDB / DocumentDB wire-protocol command documents — as written
// to the DocumentDB profiler and audit logs, MongoDB slow-query logs
// (attr.command), currentOp output and drivers' command monitoring — into
// mongosh statements that can be run or explained:
//
//   {"find":"discount","filter":{…},"$db":"discount","lsid":{…}}
//   → use discount
//     db.discount.find({ … });
//
// Input: one command, a JSON array of commands, or one per line (text before
// the first "{" on a line, e.g. a log timestamp, is ignored). Extended JSON
// ($oid, $date, $numberLong, $binary …) becomes shell syntax. No dependencies;
// the caller passes the long-line wrapper (jswrap.ts).

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Session / transport fields that are not part of the query. */
const NOISE = new Set([
  '$db',
  'lsid',
  'txnNumber',
  'autocommit',
  'startTransaction',
  '$clusterTime',
  '$readPreference',
  'readConcern',
  'writeConcern',
  '$audit',
  '$client',
  'apiVersion',
  'apiStrict',
  'apiDeprecationErrors',
  '$configServerState',
  'shardVersion',
  'databaseVersion',
  'mayBypassWriteBlocking',
  'needsMerge',
  'fromMongos',
  'cursor',
  'batchSize',
  'singleBatch',
  'ordered',
  'bypassDocumentValidation',
  'let',
]);

// ---- value printing -----------------------------------------------------------------

const IDENT = /^[A-Za-z_$][\w$]*$/;
const quote = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
const key = (k: string) => (IDENT.test(k) ? k : quote(k));

function uuidFromBase64(b64: string): string | null {
  try {
    const bin = atob(b64);
    if (bin.length !== 16) return null;
    const hex = [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

/** Extended JSON wrapper → shell expression, or null if `o` is a plain object. */
function ejson(o: Obj): string | null {
  const keys = Object.keys(o);
  const only = (k: string) => keys.length === 1 && keys[0] === k;
  if (only('$oid')) return `ObjectId(${quote(String(o.$oid))})`;
  if (only('$date')) {
    const d = o.$date;
    if (typeof d === 'string') return `ISODate(${quote(d)})`;
    const ms = isObj(d) && d.$numberLong != null ? Number(d.$numberLong) : Number(d);
    return Number.isFinite(ms) ? `ISODate(${quote(new Date(ms).toISOString())})` : `ISODate(${quote(String(d))})`;
  }
  if (only('$numberLong')) {
    const n = Number(o.$numberLong);
    return Number.isSafeInteger(n) ? String(n) : `Long(${quote(String(o.$numberLong))})`;
  }
  if (only('$numberInt')) return String(Number(o.$numberInt));
  if (only('$numberDouble')) {
    const v = String(o.$numberDouble);
    return v === 'Infinity' || v === '-Infinity' || v === 'NaN' ? v : String(Number(v));
  }
  if (only('$numberDecimal')) return `Decimal128(${quote(String(o.$numberDecimal))})`;
  if (only('$minKey')) return 'MinKey()';
  if (only('$maxKey')) return 'MaxKey()';
  if (only('$undefined')) return 'undefined';
  if (only('$symbol')) return quote(String(o.$symbol));
  if (only('$timestamp') && isObj(o.$timestamp)) return `Timestamp({ t: ${o.$timestamp.t}, i: ${o.$timestamp.i} })`;
  if (only('$regularExpression') && isObj(o.$regularExpression)) {
    const { pattern, options } = o.$regularExpression;
    return `/${String(pattern).replace(/\//g, '\\/')}/${options ?? ''}`;
  }
  // canonical {"$binary":{"base64","subType"}} and legacy {"$binary":"…","$type":"04"}
  if (keys[0] === '$binary' && (keys.length === 1 || (keys.length === 2 && '$type' in o))) {
    const b64 = isObj(o.$binary) ? o.$binary.base64 : o.$binary;
    const sub = String((isObj(o.$binary) ? o.$binary.subType : o.$type) ?? '00').padStart(2, '0');
    if (sub === '04') {
      const u = uuidFromBase64(String(b64));
      if (u) return `UUID(${quote(u)})`;
    }
    return `Binary.createFromBase64(${quote(String(b64))}, ${parseInt(sub, 16)})`;
  }
  return null;
}

/** JavaScript (mongosh) source for a value, on one line. */
export function toShell(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? `[${v.map(toShell).join(', ')}]` : '[]';
  if (isObj(v)) {
    const e = ejson(v);
    if (e != null) return e;
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([k, x]) => `${key(k)}: ${toShell(x)}`).join(', ')} }`;
  }
  return String(v);
}

// ---- commands -----------------------------------------------------------------------

const COLL_METHODS = new Set([
  'find', 'findOne', 'aggregate', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'drop', 'stats', 'explain', 'count', 'distinct', 'getName', 'getIndexes', 'watch', 'runCommand', 'getMongo',
  'getSiblingDB', 'getCollection', 'version', 'help', 'hello',
]); // prettier-ignore

function collRef(name: string): string {
  return IDENT.test(name) && !COLL_METHODS.has(name) ? `db.${name}` : `db.getCollection(${quote(name)})`;
}

/** Options object built from the listed command fields (renamed where mongosh differs). */
function options(cmd: Obj, fields: [from: string, to?: string][]): string {
  const parts: string[] = [];
  for (const [from, to] of fields) if (cmd[from] !== undefined) parts.push(`${key(to ?? from)}: ${toShell(cmd[from])}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '';
}

const args = (...a: string[]) => {
  while (a.length && !a[a.length - 1]) a.pop();
  return a.map((x) => x || '{}').join(', ');
};

const isUpdateDoc = (u: unknown) => Array.isArray(u) || (isObj(u) && Object.keys(u).some((k) => k.startsWith('$')));

interface Converted {
  db?: string;
  code: string;
}

/** Converts one command document; unknown commands become db.runCommand(…). */
export function commandToShell(cmd: Obj): Converted {
  const name = Object.keys(cmd)[0] ?? '';
  const target = cmd[name];
  const db = typeof cmd.$db === 'string' ? cmd.$db : undefined;
  const coll = typeof target === 'string' ? collRef(target) : '';
  const out = (code: string): Converted => ({ db, code });

  switch (name.toLowerCase()) {
    case 'find': {
      let s = `${coll}.find(${args(cmd.filter ? toShell(cmd.filter) : '', cmd.projection ? toShell(cmd.projection) : '')})`;
      if (cmd.sort) s += `.sort(${toShell(cmd.sort)})`;
      if (cmd.skip) s += `.skip(${toShell(cmd.skip)})`;
      if (cmd.limit) s += `.limit(${toShell(cmd.limit)})`;
      if (cmd.hint) s += `.hint(${toShell(cmd.hint)})`;
      if (cmd.collation) s += `.collation(${toShell(cmd.collation)})`;
      if (cmd.maxTimeMS) s += `.maxTimeMS(${toShell(cmd.maxTimeMS)})`;
      if (cmd.allowDiskUse) s += `.allowDiskUse()`;
      if (cmd.comment != null) s += `.comment(${toShell(cmd.comment)})`;
      return out(s + ';');
    }
    case 'aggregate': {
      const opts = options(cmd, [['allowDiskUse'], ['hint'], ['collation'], ['maxTimeMS'], ['comment']]);
      const pipeline = toShell(cmd.pipeline ?? []);
      // aggregate: 1 → database-level pipeline ($currentOp, $listLocalSessions …)
      const on = typeof target === 'string' ? coll : 'db';
      return out(`${on}.aggregate(${args(pipeline, opts)});`);
    }
    case 'count': {
      const opts = options(cmd, [['limit'], ['skip'], ['hint'], ['collation'], ['maxTimeMS']]);
      return out(`${coll}.countDocuments(${args(cmd.query ? toShell(cmd.query) : '{}', opts)});`);
    }
    case 'distinct': {
      const opts = options(cmd, [['collation'], ['maxTimeMS']]);
      return out(`${coll}.distinct(${args(toShell(cmd.key), cmd.query ? toShell(cmd.query) : '', opts)});`);
    }
    case 'insert': {
      const docs: unknown[] = Array.isArray(cmd.documents) ? cmd.documents : [];
      return out(
        docs.length === 1 ? `${coll}.insertOne(${toShell(docs[0])});` : `${coll}.insertMany(${toShell(docs)});`,
      );
    }
    case 'update': {
      const ups: Obj[] = Array.isArray(cmd.updates) ? cmd.updates.filter(isObj) : [];
      const lines = ups.map((u) => {
        const opts = options(u, [['upsert'], ['arrayFilters'], ['hint'], ['collation']]);
        const method = !isUpdateDoc(u.u) ? 'replaceOne' : u.multi ? 'updateMany' : 'updateOne';
        return `${coll}.${method}(${args(toShell(u.q ?? {}), toShell(u.u ?? {}), opts)});`;
      });
      return out(lines.join('\n') || `db.runCommand(${toShell(clean(cmd))});`);
    }
    case 'delete': {
      const dels: Obj[] = Array.isArray(cmd.deletes) ? cmd.deletes.filter(isObj) : [];
      const lines = dels.map((d) => {
        const opts = options(d, [['hint'], ['collation']]);
        return `${coll}.${d.limit === 1 ? 'deleteOne' : 'deleteMany'}(${args(toShell(d.q ?? {}), opts)});`;
      });
      return out(lines.join('\n') || `db.runCommand(${toShell(clean(cmd))});`);
    }
    case 'findandmodify': {
      const opts = options(cmd, [
        ['sort'],
        ['fields', 'projection'],
        ['upsert'],
        ['arrayFilters'],
        ['hint'],
        ['collation'],
        ['maxTimeMS'],
      ]);
      const after = cmd.new
        ? opts
          ? opts.replace(/ }$/, ", returnDocument: 'after' }")
          : "{ returnDocument: 'after' }"
        : opts;
      const q = toShell(cmd.query ?? {});
      if (cmd.remove) return out(`${coll}.findOneAndDelete(${args(q, opts)});`);
      const method = isUpdateDoc(cmd.update) ? 'findOneAndUpdate' : 'findOneAndReplace';
      return out(`${coll}.${method}(${args(q, toShell(cmd.update ?? {}), after)});`);
    }
    case 'createindexes': {
      const idx: Obj[] = Array.isArray(cmd.indexes) ? cmd.indexes.filter(isObj) : [];
      return out(
        idx
          .map((i) => {
            const { key: k, v: _v, ns: _ns, ...rest } = i;
            return `${coll}.createIndex(${args(toShell(k ?? {}), Object.keys(rest).length ? toShell(rest) : '')});`;
          })
          .join('\n'),
      );
    }
    case 'getmore':
      return out(`// getMore — 앞선 커서(${toShell(cmd.getMore)})의 다음 배치 요청 (${toShell(cmd.collection)})`);
    case 'explain':
      if (isObj(target)) {
        const inner = commandToShell({ ...target, $db: target.$db ?? db });
        const verb = toShell(cmd.verbosity ?? 'executionStats');
        return {
          db: inner.db,
          code: inner.code.replace(/^(db(?:\.\w+|\.getCollection\([^)]*\)))\./, `$1.explain(${verb}).`),
        };
      }
  }
  return out(`db.runCommand(${toShell(clean(cmd))});`);
}

function clean(cmd: Obj): Obj {
  const o: Obj = {};
  for (const [k, v] of Object.entries(cmd)) if (!NOISE.has(k)) o[k] = v;
  return o;
}

// ---- log entries ------------------------------------------------------------------------

/** Unwraps profiler / slow-log entries; returns the command and a short note. */
function unwrap(o: Obj): { cmd: Obj; note: string } | null {
  // MongoDB 4.4+ structured log: { t, s, c, msg: "Slow query", attr: { ns, command, durationMillis … } }
  if (isObj(o.attr) && isObj(o.attr.command)) return { cmd: withDb(o.attr.command, o.attr.ns), note: note(o.attr) };
  // DocumentDB profiler / MongoDB system.profile / currentOp: { op, ns, command, millis … }
  if (isObj(o.command)) return { cmd: withDb(o.command, o.ns), note: note(o) };
  if (isObj(o.originatingCommand) && !Object.keys(o).some((k) => /^(find|aggregate)$/.test(k)))
    return { cmd: withDb(o.originatingCommand, o.ns), note: note(o) };
  // a bare command
  const first = Object.keys(o)[0];
  if (first && !first.startsWith('$')) return { cmd: o, note: '' };
  return null;
}

function withDb(cmd: Obj, ns: unknown): Obj {
  if (cmd.$db || typeof ns !== 'string' || !ns.includes('.')) return cmd;
  return { ...cmd, $db: ns.slice(0, ns.indexOf('.')) };
}

function note(o: Obj): string {
  const parts: string[] = [];
  const ms = o.millis ?? o.durationMillis ?? o.microsecs_running;
  if (ms != null)
    parts.push(o.microsecs_running != null && o.millis == null ? `${Math.round(ms / 1000)} ms` : `${ms} ms`);
  if (o.planSummary) parts.push(String(o.planSummary));
  const n = (k: string) => (o[k] != null ? Number(isObj(o[k]) ? (o[k].$numberLong ?? o[k].$numberInt) : o[k]) : null);
  const docs = n('docsExamined');
  const keys = n('keysExamined');
  const ret = n('nreturned') ?? n('nReturned');
  if (keys != null) parts.push(`키 ${keys}`);
  if (docs != null) parts.push(`문서 ${docs} 검사`);
  if (ret != null) parts.push(`${ret}건 반환`);
  if (o.user) parts.push(String(o.user));
  return parts.join(' · ');
}

export interface ConvertResult {
  text: string;
  converted: number;
  skipped: number;
}

/** Converts every command found in the text. */
export function convertCommands(text: string, wrap: (code: string) => string = (c) => c): ConvertResult {
  const values: unknown[] = [];
  let skipped = 0;
  const trimmed = text.trim();
  let whole: unknown;
  try {
    whole = JSON.parse(trimmed);
  } catch {
    whole = undefined;
  }
  if (whole !== undefined) values.push(...(Array.isArray(whole) ? whole : [whole]));
  else
    for (const line of text.split('\n')) {
      const i = line.indexOf('{');
      if (i < 0) {
        if (line.trim()) skipped++;
        continue;
      }
      try {
        values.push(JSON.parse(line.slice(i).trim()));
      } catch {
        skipped++;
      }
    }

  const out: string[] = [];
  let curDb: string | undefined;
  let converted = 0;
  for (const v of values) {
    const u = isObj(v) ? unwrap(v) : null;
    if (!u) {
      skipped++;
      continue;
    }
    const c = commandToShell(u.cmd);
    if (c.db && c.db !== curDb) {
      if (out.length) out.push('');
      out.push(`use ${c.db}`);
      curDb = c.db;
    }
    if (u.note) out.push(`// ${u.note}`);
    out.push(c.code);
    converted++;
  }
  return { text: wrap(out.join('\n')) + (out.length ? '\n' : ''), converted, skipped };
}
