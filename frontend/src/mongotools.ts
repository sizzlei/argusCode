// mongosh helpers for JavaScript documents: completion for db / collection /
// cursor / rs / sh methods and query, update and aggregation operators, plus
// hover help. Collection names come from the document itself (db.orders,
// db.getCollection('orders')). Loaded together with the JavaScript language.

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { hoverTooltip, EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

type Entry = [name: string, signature: string, info: string];

const DB: Entry[] = [
  ['getCollection', "getCollection('name')", '이름으로 컬렉션 가져오기 (특수문자가 있는 이름)'],
  ['getCollectionNames', 'getCollectionNames()', '컬렉션 이름 목록'],
  ['getCollectionInfos', 'getCollectionInfos(filter?)', '컬렉션 정보(옵션, 검증 규칙 포함)'],
  ['createCollection', "createCollection('name', options?)", '컬렉션 생성 (capped, validator, timeseries …)'],
  ['createView', "createView('view', 'source', pipeline)", '뷰 생성'],
  ['getSiblingDB', "getSiblingDB('db')", '같은 연결에서 다른 데이터베이스 사용'],
  ['getName', 'getName()', '현재 데이터베이스 이름'],
  ['stats', 'stats(scale?)', '데이터베이스 통계 (dataSize, storageSize, indexSize …)'],
  ['runCommand', 'runCommand({ … })', '데이터베이스 명령 실행'],
  ['adminCommand', 'adminCommand({ … })', 'admin 데이터베이스에서 명령 실행'],
  ['currentOp', 'currentOp(filter?)', '실행 중인 작업 목록 — 예: { secs_running: { $gt: 5 } }'],
  ['killOp', 'killOp(opid)', '작업 종료'],
  ['serverStatus', 'serverStatus()', '서버 상태 (연결, opcounters, wiredTiger …)'],
  ['hostInfo', 'hostInfo()', '호스트 정보'],
  ['version', 'version()', '서버 버전'],
  ['getProfilingStatus', 'getProfilingStatus()', '프로파일러 설정'],
  ['setProfilingLevel', 'setProfilingLevel(level, { slowms })', '프로파일러 설정 — 0 끔 / 1 느린 작업 / 2 전체'],
  ['getUsers', 'getUsers()', '사용자 목록'],
  ['createUser', 'createUser({ user, pwd, roles })', '사용자 생성'],
  ['dropUser', "dropUser('name')", '사용자 삭제'],
  ['grantRolesToUser', "grantRolesToUser('user', roles)", '사용자에게 역할 부여'],
  ['getRoles', 'getRoles({ showPrivileges })', '역할 목록'],
  ['dropDatabase', 'dropDatabase()', '⚠ 현재 데이터베이스 삭제'],
  ['fsyncLock', 'fsyncLock()', '쓰기 잠금 (백업용)'],
  ['fsyncUnlock', 'fsyncUnlock()', '쓰기 잠금 해제'],
  ['getReplicationInfo', 'getReplicationInfo()', 'oplog 크기와 기간'],
  ['printSecondaryReplicationInfo', 'printSecondaryReplicationInfo()', '세컨더리 복제 지연'],
  ['aggregate', 'aggregate(pipeline)', '데이터베이스 수준 집계 — 예: [{ $currentOp: {} }]'],
  ['watch', 'watch(pipeline?)', '변경 스트림'],
];

const COLL: Entry[] = [
  ['find', 'find(filter, projection?)', '문서 조회 — 커서 반환'],
  ['findOne', 'findOne(filter, projection?)', '문서 한 건 조회'],
  ['aggregate', 'aggregate(pipeline, options?)', '집계 파이프라인 실행'],
  ['countDocuments', 'countDocuments(filter)', '조건에 맞는 문서 수 (정확, 느릴 수 있음)'],
  ['estimatedDocumentCount', 'estimatedDocumentCount()', '메타데이터 기준 문서 수 (빠름)'],
  ['distinct', "distinct('field', filter?)", '필드의 고유 값'],
  ['insertOne', 'insertOne(doc)', '문서 한 건 삽입'],
  ['insertMany', 'insertMany(docs, { ordered })', '여러 문서 삽입'],
  ['updateOne', 'updateOne(filter, update, options?)', '첫 번째 일치 문서 수정'],
  ['updateMany', 'updateMany(filter, update, options?)', '일치하는 모든 문서 수정'],
  ['replaceOne', 'replaceOne(filter, doc, options?)', '문서 교체'],
  ['deleteOne', 'deleteOne(filter)', '첫 번째 일치 문서 삭제'],
  ['deleteMany', 'deleteMany(filter)', '⚠ 일치하는 모든 문서 삭제'],
  ['findOneAndUpdate', 'findOneAndUpdate(filter, update, options?)', '수정 후 문서 반환'],
  ['findOneAndDelete', 'findOneAndDelete(filter)', '삭제 후 문서 반환'],
  ['bulkWrite', 'bulkWrite(operations, { ordered })', '여러 쓰기 작업 일괄 실행'],
  [
    'createIndex',
    'createIndex(keys, options?)',
    '인덱스 생성 — { unique, partialFilterExpression, expireAfterSeconds, name }',
  ],
  ['createIndexes', 'createIndexes([keys…], options?)', '여러 인덱스 생성'],
  ['getIndexes', 'getIndexes()', '인덱스 목록'],
  ['dropIndex', "dropIndex('name' | keys)", '인덱스 삭제'],
  ['hideIndex', "hideIndex('name')", '인덱스 숨기기 — 삭제 전 영향 확인용'],
  ['unhideIndex', "unhideIndex('name')", '숨긴 인덱스 다시 사용'],
  ['explain', "explain('executionStats')", '실행계획 — 뒤에 find/aggregate 등을 이어서 호출'],
  ['stats', 'stats({ scale })', '컬렉션 통계 (크기, 인덱스 크기, 문서 수)'],
  ['dataSize', 'dataSize()', '데이터 크기'],
  ['totalIndexSize', 'totalIndexSize()', '전체 인덱스 크기'],
  ['storageSize', 'storageSize()', '할당된 저장 공간'],
  ['validate', 'validate({ full })', '컬렉션 무결성 검사'],
  ['renameCollection', "renameCollection('newName')", '컬렉션 이름 변경'],
  ['drop', 'drop()', '⚠ 컬렉션 삭제'],
  ['watch', 'watch(pipeline?)', '변경 스트림'],
  ['getShardDistribution', 'getShardDistribution()', '샤드별 데이터 분포'],
];

const CURSOR: Entry[] = [
  ['sort', 'sort({ field: 1 | -1 })', '정렬'],
  ['limit', 'limit(n)', '개수 제한'],
  ['skip', 'skip(n)', '건너뛰기'],
  ['projection', 'projection({ … })', '반환 필드'],
  ['hint', "hint('index' | keys)", '사용할 인덱스 지정'],
  ['explain', "explain('executionStats')", '실행계획 (queryPlanner / executionStats / allPlansExecution)'],
  ['toArray', 'toArray()', '배열로 모두 가져오기'],
  ['forEach', 'forEach(fn)', '문서마다 실행'],
  ['map', 'map(fn)', '문서 변환'],
  ['count', 'count()', '개수 (deprecated — countDocuments 권장)'],
  ['itcount', 'itcount()', '커서를 끝까지 읽어 개수 세기'],
  ['batchSize', 'batchSize(n)', '배치 크기'],
  ['maxTimeMS', 'maxTimeMS(ms)', '최대 실행 시간'],
  ['readPref', "readPref('secondaryPreferred')", '읽기 대상 지정'],
  ['collation', "collation({ locale: 'ko' })", '문자열 비교 규칙'],
  ['allowDiskUse', 'allowDiskUse()', '정렬에 디스크 사용 허용'],
  ['pretty', 'pretty()', '보기 좋게 출력'],
  ['hasNext', 'hasNext()', '다음 문서가 있는지'],
  ['next', 'next()', '다음 문서'],
];

const RS: Entry[] = [
  ['status', 'rs.status()', '레플리카셋 상태 — 멤버, optime, 지연'],
  ['conf', 'rs.conf()', '레플리카셋 설정'],
  ['config', 'rs.config()', '레플리카셋 설정 (rs.conf와 같음)'],
  ['isMaster', 'rs.isMaster()', '프라이머리 여부 (구버전)'],
  ['hello', 'rs.hello()', '노드 역할 정보'],
  ['printReplicationInfo', 'rs.printReplicationInfo()', 'oplog 크기와 기간'],
  ['printSecondaryReplicationInfo', 'rs.printSecondaryReplicationInfo()', '세컨더리별 복제 지연'],
  ['stepDown', 'rs.stepDown(seconds?)', '⚠ 프라이머리 강등 (페일오버)'],
  ['freeze', 'rs.freeze(seconds)', '선출 후보에서 일시 제외'],
  ['reconfig', 'rs.reconfig(config, { force })', '⚠ 레플리카셋 설정 변경'],
  ['add', "rs.add('host:port')", '멤버 추가'],
  ['remove', "rs.remove('host:port')", '멤버 제거'],
  ['syncFrom', "rs.syncFrom('host:port')", '복제 원본 지정'],
];

const SH: Entry[] = [
  ['status', 'sh.status()', '샤딩 상태 — 샤드, 청크 분포, 밸런서'],
  ['enableSharding', "sh.enableSharding('db')", '데이터베이스 샤딩 활성화'],
  ['shardCollection', "sh.shardCollection('db.coll', { key: 1 })", '컬렉션 샤딩'],
  ['getBalancerState', 'sh.getBalancerState()', '밸런서 사용 여부'],
  ['isBalancerRunning', 'sh.isBalancerRunning()', '밸런서 실행 중인지'],
  ['startBalancer', 'sh.startBalancer()', '밸런서 시작'],
  ['stopBalancer', 'sh.stopBalancer()', '밸런서 중지'],
  ['addShard', "sh.addShard('rs/host:port')", '샤드 추가'],
  ['moveChunk', "sh.moveChunk('db.coll', query, 'shard')", '청크 이동'],
  ['splitAt', "sh.splitAt('db.coll', query)", '청크 분할'],
];

type OpKind = 'query' | 'update' | 'stage' | 'expr';
const OPS: [name: string, kind: OpKind, info: string][] = [
  // query
  ['$eq', 'query', '같음'],
  ['$ne', 'query', '같지 않음 (인덱스 효율 낮음)'],
  ['$gt', 'query', '초과'],
  ['$gte', 'query', '이상'],
  ['$lt', 'query', '미만'],
  ['$lte', 'query', '이하'],
  ['$in', 'query', '목록 중 하나'],
  ['$nin', 'query', '목록에 없음 (인덱스 효율 낮음)'],
  ['$and', 'query', '모두 만족'],
  ['$or', 'query', '하나 이상 만족 — 조건마다 인덱스 필요'],
  ['$nor', 'query', '모두 불만족'],
  ['$not', 'query', '부정'],
  ['$exists', 'query', '필드 존재 여부'],
  ['$type', 'query', 'BSON 타입'],
  ['$regex', 'query', '정규식 — 앞부분 고정(^abc)일 때만 인덱스 범위 사용'],
  ['$expr', 'query', '집계 식으로 조건 비교'],
  ['$elemMatch', 'query', '배열 요소 하나가 모든 조건 만족'],
  ['$size', 'query', '배열 길이'],
  ['$all', 'query', '배열이 모든 값 포함'],
  ['$text', 'query', '텍스트 검색'],
  ['$geoWithin', 'query', '영역 안'],
  ['$near', 'query', '가까운 순'],
  // update
  ['$set', 'update', '필드 값 설정'],
  ['$unset', 'update', '필드 제거'],
  ['$inc', 'update', '증가'],
  ['$mul', 'update', '곱하기'],
  ['$min', 'update', '더 작을 때만 설정'],
  ['$max', 'update', '더 클 때만 설정'],
  ['$rename', 'update', '필드 이름 변경'],
  ['$setOnInsert', 'update', 'upsert로 삽입될 때만 설정'],
  ['$currentDate', 'update', '현재 시각 설정'],
  ['$push', 'update', '배열에 추가'],
  ['$addToSet', 'update', '배열에 없을 때만 추가'],
  ['$pull', 'update', '배열에서 조건에 맞는 값 제거'],
  ['$pop', 'update', '배열 처음/끝 제거'],
  ['$each', 'update', '$push/$addToSet 여러 값'],
  // aggregation stages
  ['$match', 'stage', '필터 — 파이프라인 앞쪽에 두어야 인덱스 사용'],
  ['$project', 'stage', '필드 선택·계산'],
  ['$addFields', 'stage', '필드 추가'],
  ['$set', 'stage', '필드 추가 ($addFields와 같음)'],
  ['$unset', 'stage', '필드 제거'],
  ['$group', 'stage', '그룹 집계 — _id 필수'],
  ['$sort', 'stage', '정렬 — 메모리 100MB 넘으면 allowDiskUse 필요'],
  ['$limit', 'stage', '개수 제한'],
  ['$skip', 'stage', '건너뛰기'],
  ['$lookup', 'stage', '다른 컬렉션 조인 — foreignField 인덱스 확인'],
  ['$unwind', 'stage', '배열을 문서별로 펼치기'],
  ['$count', 'stage', '개수'],
  ['$facet', 'stage', '여러 파이프라인 동시 실행'],
  ['$bucket', 'stage', '구간별 그룹'],
  ['$sortByCount', 'stage', '값별 개수 정렬'],
  ['$replaceRoot', 'stage', '하위 문서를 최상위로'],
  ['$replaceWith', 'stage', '문서 교체'],
  ['$merge', 'stage', '결과를 컬렉션에 병합'],
  ['$out', 'stage', '⚠ 결과로 컬렉션 덮어쓰기'],
  ['$unionWith', 'stage', '다른 컬렉션 결과 합치기'],
  ['$sample', 'stage', '무작위 표본'],
  ['$indexStats', 'stage', '인덱스 사용 통계 — 안 쓰는 인덱스 찾기'],
  ['$collStats', 'stage', '컬렉션 통계'],
  ['$currentOp', 'stage', '실행 중인 작업 (admin, db.aggregate)'],
  ['$densify', 'stage', '빈 구간 채우기'],
  ['$setWindowFields', 'stage', '윈도 함수'],
  // expressions / accumulators
  ['$sum', 'expr', '합계'],
  ['$avg', 'expr', '평균'],
  ['$first', 'expr', '그룹의 첫 값'],
  ['$last', 'expr', '그룹의 마지막 값'],
  ['$push', 'expr', '그룹 값을 배열로'],
  ['$addToSet', 'expr', '그룹 고유 값 배열'],
  ['$cond', 'expr', '조건식 { if, then, else }'],
  ['$ifNull', 'expr', 'null이면 대체값'],
  ['$switch', 'expr', '여러 분기'],
  ['$concat', 'expr', '문자열 연결'],
  ['$substrCP', 'expr', '부분 문자열'],
  ['$toLower', 'expr', '소문자'],
  ['$toUpper', 'expr', '대문자'],
  ['$dateToString', 'expr', '날짜 → 문자열 { format, date, timezone }'],
  ['$dateTrunc', 'expr', '날짜 단위 자르기'],
  ['$toDate', 'expr', '날짜로 변환'],
  ['$toString', 'expr', '문자열로 변환'],
  ['$toInt', 'expr', '정수로 변환'],
  ['$size', 'expr', '배열 길이'],
  ['$filter', 'expr', '배열 필터'],
  ['$map', 'expr', '배열 변환'],
  ['$arrayElemAt', 'expr', '배열 요소'],
  ['$add', 'expr', '더하기'],
  ['$subtract', 'expr', '빼기'],
  ['$multiply', 'expr', '곱하기'],
  ['$divide', 'expr', '나누기'],
  ['$round', 'expr', '반올림'],
];

const KIND_LABEL: Record<OpKind, string> = { query: '조회', update: '수정', stage: '스테이지', expr: '식' };

const methodOptions = (list: Entry[], type: string): Completion[] =>
  list.map(([label, sig, info]) => ({ label, type, detail: sig, info }));

const dbOpts = methodOptions(DB, 'method');
const collOpts = methodOptions(COLL, 'method');
const cursorOpts = methodOptions(CURSOR, 'method');
const rsOpts = methodOptions(RS, 'method');
const shOpts = methodOptions(SH, 'method');

const DB_METHODS = new Set(DB.map(([n]) => n));

/** Collection names mentioned in the document. */
function collections(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bdb\.([A-Za-z_$][\w$]*)\s*\./g)) if (!DB_METHODS.has(m[1])) out.add(m[1]);
  for (const m of text.matchAll(/\bgetCollection\(\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
}

/** Rough guess whether the cursor is inside an aggregate([...]) call. */
function inAggregate(before: string): boolean {
  const agg = before.lastIndexOf('aggregate(');
  if (agg < 0) return false;
  let depth = 0;
  for (let i = agg + 'aggregate'.length; i < before.length; i++) {
    const c = before[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return false;
  }
  return depth > 0;
}

function mongoComplete(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  // $operators — bare or inside quotes
  const op = /(['"]?)(\$\w*)$/.exec(before);
  if (op) {
    const from = ctx.pos - op[2].length;
    const agg = inAggregate(ctx.state.sliceDoc(Math.max(0, ctx.pos - 4000), ctx.pos));
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const [name, kind, info] of OPS) {
      const key = name + kind;
      if (seen.has(key)) continue;
      seen.add(key);
      const boost = agg
        ? kind === 'stage'
          ? 2
          : kind === 'expr'
            ? 1
            : -1
        : kind === 'stage' || kind === 'expr'
          ? -2
          : 1;
      options.push({
        label: name,
        type: kind === 'stage' ? 'class' : 'keyword',
        detail: KIND_LABEL[kind],
        info,
        boost,
      });
    }
    return { from, options, validFor: /^\$\w*$/ };
  }

  const word = /[\w$]*$/.exec(before)![0];
  const from = ctx.pos - word.length;
  const head = before.slice(0, before.length - word.length);

  if (/\brs\.$/.test(head)) return { from, options: rsOpts, validFor: /^\w*$/ };
  if (/\bsh\.$/.test(head)) return { from, options: shOpts, validFor: /^\w*$/ };
  if (/(?:^|[^\w$.])db\.$/.test(head)) {
    const colls = collections(ctx.state.doc.toString()).map((c): Completion => ({
      label: c,
      type: 'variable',
      detail: '컬렉션',
      boost: 1,
    }));
    return { from, options: [...colls, ...dbOpts], validFor: /^[\w$]*$/ };
  }
  // db.<coll>.  /  db.getCollection('x').  /  db.<coll>.explain(…).
  const coll = /\bdb\.(?:getCollection\([^)]*\)|([A-Za-z_$][\w$]*))\.(?:explain\([^)]*\)\.)?$/.exec(head);
  if (coll && !(coll[1] && DB_METHODS.has(coll[1]))) return { from, options: collOpts, validFor: /^\w*$/ };
  // .find(...).  → cursor methods
  if (
    /\)\s*\.$/.test(head) &&
    /\b(find|aggregate|sort|limit|skip|hint|projection|batchSize|maxTimeMS|collation|readPref)\s*\(/.test(head)
  )
    return { from, options: cursorOpts, validFor: /^\w*$/ };
  return null;
}

// ---- hover ----------------------------------------------------------------------------

type Help = [head: string, kind: string, info: string];
const HOVER = new Map<string, Help[]>();
const addHover = (name: string, h: Help) => HOVER.set(name, [...(HOVER.get(name) ?? []), h]);
for (const [n, sig, info] of DB) addHover('db.' + n, ['db.' + sig, 'db', info]);
for (const [n, sig, info] of COLL) addHover('coll.' + n, [sig, '컬렉션', info]);
for (const [n, sig, info] of CURSOR) addHover('cursor.' + n, [sig, '커서', info]);
for (const [n, sig, info] of RS) addHover('rs.' + n, [sig, '레플리카셋', info]);
for (const [n, sig, info] of SH) addHover('sh.' + n, [sig, '샤딩', info]);
for (const [n, kind, info] of OPS) addHover(n, [n, KIND_LABEL[kind], info]);

const mongoHover = hoverTooltip((view: EditorView, pos: number) => {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let a = pos - line.from;
  let b = a;
  while (a > 0 && /[\w$]/.test(text[a - 1])) a--;
  while (b < text.length && /[\w$]/.test(text[b])) b++;
  if (a === b) return null;
  const word = text.slice(a, b);
  const before = text.slice(0, a);
  let keys: string[] = [];
  if (word.startsWith('$')) keys = [word];
  else if (/\brs\.$/.test(before)) keys = ['rs.' + word];
  else if (/\bsh\.$/.test(before)) keys = ['sh.' + word];
  else if (/(?:^|[^\w$.])db\.$/.test(before)) keys = ['db.' + word];
  else if (/\)\s*\.$/.test(before)) keys = ['cursor.' + word, 'coll.' + word];
  else if (/\.$/.test(before)) keys = ['coll.' + word, 'cursor.' + word];
  const lines = keys.flatMap((k) => HOVER.get(k) ?? []).slice(0, 4);
  if (!lines.length) return null;
  return {
    pos: line.from + a,
    end: line.from + b,
    above: true,
    create() {
      const el = (tag: string, cls: string, text: string) => {
        const e = document.createElement(tag);
        e.className = cls;
        e.textContent = text;
        return e;
      };
      const dom = el('div', 'sql-hover', '');
      for (const [head, kind, info] of lines) {
        const h = el('div', 'sql-hover-head', '');
        h.append(el('strong', '', head), el('span', 'sql-hover-type', ' ' + kind));
        dom.append(h, el('div', 'sql-hover-comment', info));
      }
      return { dom };
    },
  };
});

export function mongoCompletionSource() {
  return mongoComplete;
}

export function mongoExtensions(): Extension {
  return [mongoHover];
}
