/*!
 * Tiny recursive fixed-point engine.
 * Plain browser global + CommonJS export. No dependencies.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.FixpointEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const MI_BYTES = 1024 * 1024;

  class ParseError extends Error {
    constructor(message, line) {
      super(line ? `第 ${line} 行: ${message}` : message);
      this.name = 'ParseError';
      this.line = line || null;
      this.code = 'PARSE_ERROR';
    }
  }

  class MemoryLimitError extends Error {
    constructor(message, memory) {
      super(message);
      this.name = 'MemoryLimitError';
      this.code = 'MEMORY_LIMIT';
      this.memory = memory || null;
    }
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function textByteLength(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return Buffer.byteLength(s, 'utf8');
  }

  /* ----------------------------- parsing ----------------------------- */

  function tokenize(input) {
    const src = String(input || '');
    const tokens = [];
    let i = 0;
    let line = 1;

    function push(type, value, tokLine) {
      tokens.push({ type, value, line: tokLine || line });
    }

    while (i < src.length) {
      const c = src[i];
      if (c === '\n') { line += 1; i += 1; continue; }
      if (/\s/.test(c)) { i += 1; continue; }

      if (c === '%' || c === '#') {
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '-' && src[i + 1] === '-') {
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }

      const tokLine = line;

      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1;
        let value = '';
        while (j < src.length && src[j] !== quote) {
          if (src[j] === '\\' && j + 1 < src.length) {
            const esc = src[j + 1];
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
            j += 2;
          } else {
            if (src[j] === '\n') line += 1;
            value += src[j];
            j += 1;
          }
        }
        if (j >= src.length) throw new ParseError('字符串没有结束引号', tokLine);
        push('string', value, tokLine);
        i = j + 1;
        continue;
      }

      if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
        push('ident', src.slice(i, j), tokLine);
        i = j;
        continue;
      }

      if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
        let j = i + (c === '-' ? 1 : 0);
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
        if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) {
          j += 1;
          while (j < src.length && /[0-9]/.test(src[j])) j += 1;
        }
        const raw = src.slice(i, j);
        push('number', Number(raw), tokLine);
        i = j;
        continue;
      }

      const two = src.slice(i, i + 2);
      if (two === ':-' || two === '<-' || two === ':=' || two === '!=' || two === '<>' || two === '<=' || two === '>=') {
        push('punct', two, tokLine);
        i += 2;
        continue;
      }

      if ('(){},;.=+-*/<>|'.includes(c)) {
        push('punct', c, tokLine);
        i += 1;
        continue;
      }

      throw new ParseError(`无法识别的字符 “${c}”`, tokLine);
    }

    tokens.push({ type: 'eof', value: null, line });
    return tokens;
  }

  class Parser {
    constructor(text) {
      this.text = text;
      this.tokens = tokenize(text);
      this.pos = 0;
    }

    peek(offset = 0) {
      return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
    }

    next() {
      const t = this.tokens[this.pos];
      if (this.pos < this.tokens.length - 1) this.pos += 1;
      return t;
    }

    expectPunct(value) {
      const t = this.peek();
      if (t.type !== 'punct' || t.value !== value) {
        throw new ParseError(`应为 “${value}”，实际为 “${t.value === null ? '文件结束' : t.value}”`, t.line);
      }
      return this.next();
    }

    isPunct(value) {
      const t = this.peek();
      return t.type === 'punct' && (value === undefined || t.value === value);
    }

    consumeTerminator() {
      if (this.isPunct('.') || this.isPunct(';')) return this.next();
      const t = this.peek();
      throw new ParseError('语句应以 “.” 或 “;” 结束', t.line);
    }

    parseProgram() {
      const tables = [];
      const rules = [];
      const facts = [];

      while (this.peek().type !== 'eof') {
        const t = this.peek();
        if (t.type === 'ident' && t.value === 'table') {
          tables.push(this.parseTable());
        } else {
          const parsed = this.parseRuleOrFact();
          if (parsed.kind === 'rule') rules.push(parsed.rule);
          else facts.push(parsed.fact);
        }
      }

      return { tables, rules, facts };
    }

    parseTable() {
      const start = this.next(); // table
      const nameTok = this.peek();
      if (nameTok.type !== 'ident') throw new ParseError('table 后需要表名', nameTok.line);
      const name = this.next().value;

      let columns = [];
      if (this.isPunct('(')) {
        this.next();
        const inside = [];
        while (!this.isPunct(')')) {
          const t = this.next();
          if (t.type !== 'ident' && t.type !== 'number') {
            throw new ParseError('列名或元数描述无效', t.line);
          }
          inside.push(t);
          if (this.isPunct(',')) this.next();
          else break;
        }
        this.expectPunct(')');
        if (inside.length === 1 && inside[0].type === 'number') {
          const arity = inside[0].value;
          if (!Number.isInteger(arity) || arity < 0 || arity > 32) {
            throw new ParseError('表元数必须是 0 到 32 的整数', start.line);
          }
          columns = Array.from({ length: arity }, (_, i) => `c${i + 1}`);
        } else {
          columns = inside.map((t) => String(t.value));
        }
      }

      if (this.isPunct('=')) this.next();
      if (this.isPunct(':')) { this.next(); this.expectPunct('='); }
      this.expectPunct('{');

      const rows = [];
      while (!this.isPunct('}') && this.peek().type !== 'eof') {
        rows.push(this.parseTupleValue());
        if (this.isPunct(',')) this.next();
        else if (!this.isPunct('}')) {
          const t = this.peek();
          throw new ParseError('表元组之间应以逗号分隔', t.line);
        }
      }
      this.expectPunct('}');
      if (this.isPunct('.') || this.isPunct(';')) this.next();

      return { name, columns, rows, line: start.line };
    }

    parseTupleValue() {
      this.expectPunct('(');
      const values = [];
      while (!this.isPunct(')')) {
        values.push(this.parseDataValue());
        if (this.isPunct(',')) this.next();
        else break;
      }
      this.expectPunct(')');
      return values;
    }

    parseDataValue() {
      const t = this.peek();
      if (t.type === 'number' || t.type === 'string') {
        this.next();
        return t.value;
      }
      if (t.type === 'ident') {
        this.next();
        if (t.value === 'true') return true;
        if (t.value === 'false') return false;
        if (t.value === 'null') return null;
        return t.value; // Data tables treat bare identifiers as constants.
      }
      throw new ParseError('表中只允许数字、字符串或常量标识符', t.line);
    }

    parseRuleOrFact() {
      const head = this.parseAtom();
      const line = head.line;

      if (this.isPunct(':-') || this.isPunct('<-')) {
        this.next();
        const body = [];
        while (!this.isPunct('.') && !this.isPunct(';') && this.peek().type !== 'eof') {
          const bt = this.peek();
          if (bt.type === 'ident' && (bt.value === 'not' || bt.value === 'not')) {
            throw new ParseError('这个小型引擎暂不支持 not/否定规则', bt.line);
          }
          body.push(this.parseAtom());
          if (this.isPunct(',')) this.next();
          else break;
        }
        this.consumeTerminator();
        return { kind: 'rule', rule: { head, body, line } };
      }

      this.consumeTerminator();
      return { kind: 'fact', fact: { atom: head, line } };
    }

    parseAtom() {
      const nameTok = this.peek();
      if (nameTok.type !== 'ident') {
        throw new ParseError(`应为谓词名，实际为 “${nameTok.value || nameTok.type}”`, nameTok.line);
      }
      this.next();
      const args = [];
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')') && this.peek().type !== 'eof') {
          args.push(this.parseArg());
          if (this.isPunct(',')) this.next();
          else break;
        }
        this.expectPunct(')');
      }
      return { kind: 'atom', name: nameTok.value, args, line: nameTok.line };
    }

    parseArg() {
      const t = this.peek();
      if (t.type === 'number' || t.type === 'string') {
        this.next();
        return { kind: 'const', value: t.value };
      }
      if (t.type === 'ident') {
        this.next();
        if (t.value === 'true') return { kind: 'const', value: true };
        if (t.value === 'false') return { kind: 'const', value: false };
        if (t.value === 'null') return { kind: 'const', value: null };
        if (t.value === '_') {
          return { kind: 'var', name: `_wild_${tokens_uid()}`, wildcard: true };
        }
        if (/^[A-Z_]/.test(t.value)) return { kind: 'var', name: t.value };
        return { kind: 'const', value: t.value };
      }
      throw new ParseError('参数应为变量、数字、字符串或常量', t.line);
    }
  }

  let uidCounter = 0;
  function tokens_uid() {
    uidCounter += 1;
    return uidCounter;
  }

  function parseProgram(text) {
    return new Parser(text).parseProgram();
  }

  /* --------------------------- semantic model -------------------------- */

  function tupleIdentity(tuple) {
    return JSON.stringify(tuple);
  }

  function compileProgram(parsed) {
    const predicates = new Map();
    const tables = new Map();

    function ensurePredicate(name, arity, line) {
      if (!predicates.has(name)) {
        predicates.set(name, { name, arity, columns: null, recursive: false });
      }
      const p = predicates.get(name);
      if (arity !== undefined && arity !== null && p.arity !== null && p.arity !== arity) {
        throw new ParseError(`谓词 ${name}/${arity} 与之前的元数 ${p.arity} 不一致`, line);
      }
      if (arity !== undefined && arity !== null) p.arity = arity;
      return p;
    }

    for (const table of parsed.tables || []) {
      if (!tables.has(table.name)) tables.set(table.name, []);
      const p = ensurePredicate(table.name, table.columns.length || (table.rows[0] ? table.rows[0].length : null), table.line);
      if (table.columns.length) p.columns = table.columns.slice();

      const seen = new Set(tables.get(table.name).map(tupleIdentity));
      for (const row of table.rows) {
        ensurePredicate(table.name, row.length, table.line);
        if (row.length !== p.arity) {
          throw new ParseError(`表 ${table.name} 中有元组元数为 ${row.length}，应为 ${p.arity}`, table.line);
        }
        const id = tupleIdentity(row);
        if (!seen.has(id)) {
          seen.add(id);
          tables.get(table.name).push(row.slice());
        }
      }
    }

    for (const fact of parsed.facts || []) {
      const atom = fact.atom;
      ensurePredicate(atom.name, atom.args.length, fact.line);
      if (!tables.has(atom.name)) tables.set(atom.name, []);
      const row = atom.args.map((arg) => {
        if (arg.kind !== 'const') {
          throw new ParseError('直接事实不能包含变量；变量请写在规则中', fact.line);
        }
        return arg.value;
      });
      const rows = tables.get(atom.name);
      const id = tupleIdentity(row);
      if (!rows.some((r) => tupleIdentity(r) === id)) rows.push(row);
    }

    const rules = (parsed.rules || []).map((r, i) => ({
      ...r,
      id: `R${i + 1}`,
      label: `${r.head.name}/${r.head.args.length}`,
    }));

    for (const rule of rules) {
      ensurePredicate(rule.head.name, rule.head.args.length, rule.line);
      const hp = predicates.get(rule.head.name);
      hp.recursive = true;
      for (const atom of rule.body) {
        ensurePredicate(atom.name, atom.args.length, atom.line);
      }
    }

    for (const rule of rules) {
      const bound = new Set();
      for (const atom of rule.body) {
        for (const arg of atom.args) {
          if (arg.kind === 'var' && !arg.wildcard) bound.add(arg.name);
        }
      }
      for (const arg of rule.head.args) {
        if (arg.kind === 'var' && !arg.wildcard && !bound.has(arg.name)) {
          throw new ParseError(
            `规则 ${formatAtom(rule.head)} 中的变量 ${arg.name} 没有在正文中安全出现`,
            rule.line
          );
        }
        if (arg.kind === 'var' && arg.wildcard) {
          throw new ParseError('头部不建议使用 _，因为该值无法被约束', rule.line);
        }
      }

      for (const atom of rule.body) {
        const p = predicates.get(atom.name);
        if (!p) throw new ParseError(`未知谓词 ${atom.name}`, atom.line);
        if (p.arity !== atom.args.length) {
          throw new ParseError(`原子 ${formatAtom(atom)} 的元数应为 ${p.arity}`, atom.line);
        }
      }
      const hp = predicates.get(rule.head.name);
      if (hp.arity !== rule.head.args.length) {
        throw new ParseError(`规则头元数与谓词 ${rule.head.name}/${hp.arity} 不一致`, rule.line);
      }
    }

    // Predicates mentioned nowhere are still absent; body checks above ensure known.
    for (const [name, p] of predicates) {
      if (!p.columns) p.columns = Array.from({ length: p.arity || 0 }, (_, i) => `c${i + 1}`);
      if (!tables.has(name)) tables.set(name, []);
    }

    return { predicates, tables, rules };
  }

  /* ------------------------------ values ------------------------------ */

  function valuesEqual(a, b) {
    return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
  }

  function tupleKey(relationName, tuple) {
    return JSON.stringify([relationName, tuple]);
  }

  function compareValues(a, b) {
    const rank = (v) => {
      if (v === null || v === undefined) return 4;
      if (typeof v === 'number') return 0;
      if (typeof v === 'boolean') return 1;
      if (typeof v === 'string') return 2;
      return 3;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  function compareTuples(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const c = compareValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }

  function sortTuples(rows) {
    return rows.slice().sort(compareTuples);
  }

  function formatValue(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  function formatTuple(tuple) {
    return `(${tuple.map(formatValue).join(', ')})`;
  }

  function formatArg(arg) {
    if (arg.kind === 'const') return formatValue(arg.value);
    return arg.name;
  }

  function formatAtom(atom) {
    if (!atom.args || atom.args.length === 0) return atom.name;
    return `${atom.name}(${atom.args.map(formatArg).join(', ')})`;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '∞';
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < MI_BYTES) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / MI_BYTES).toFixed(2)} MiB`;
  }

  /* --------------------------- memory meter -------------------------- */

  const COSTS = {
    tupleHeader: 40,
    argSlot: 8,
    numberValue: 8,
    booleanValue: 4,
    nullValue: 0,
    stringHeader: 24,
    setEntry: 56,
    mapEntry: 64,
    arraySlot: 8,
  };

  function valueBytes(v) {
    if (typeof v === 'number') return COSTS.numberValue;
    if (typeof v === 'boolean') return COSTS.booleanValue;
    if (v === null || v === undefined) return COSTS.nullValue;
    return COSTS.stringHeader + textByteLength(String(v));
  }

  function tupleBytes(tuple) {
    let n = COSTS.tupleHeader + tuple.length * COSTS.argSlot;
    for (const v of tuple) n += valueBytes(v);
    return n;
  }

  function indexEntryBytes(key) {
    return COSTS.setEntry + COSTS.arraySlot + COSTS.stringHeader + textByteLength(key);
  }

  function mapEntryOverheadBytes() {
    return COSTS.mapEntry;
  }

  class MemoryMeter {
    constructor(limitMiB) {
      const mib = Number(limitMiB);
      this.limitBytes = Number.isFinite(mib) && mib > 0 ? Math.floor(mib * MI_BYTES) : Infinity;
      this.usedBytes = 0;
      this.peakBytes = 0;
      this.categories = {};
      this.categoryPeaks = {};
    }

    availableBytes() {
      return this.limitBytes - this.usedBytes;
    }

    check(additional) {
      const n = Math.max(0, additional);
      if (Number.isFinite(this.limitBytes) && this.usedBytes + n > this.limitBytes) {
        const snap = this.snapshot();
        throw new MemoryLimitError(
          `内存限额 ${formatBytes(this.limitBytes)} 不足：还需约 ${formatBytes(n)}，当前逻辑占用 ${formatBytes(this.usedBytes)}，峰值 ${formatBytes(this.peakBytes)}`,
          snap
        );
      }
    }

    reserve(category, bytes) {
      const n = Math.max(0, Math.round(bytes));
      this.check(n);
      this.categories[category] = (this.categories[category] || 0) + n;
      this.usedBytes += n;
      this.peakBytes = Math.max(this.peakBytes, this.usedBytes);
      this.categoryPeaks[category] = Math.max(this.categoryPeaks[category] || 0, this.categories[category]);
      return n;
    }

    release(category, bytes) {
      const n = Math.max(0, Math.round(bytes));
      this.categories[category] = Math.max(0, (this.categories[category] || 0) - n);
      this.usedBytes = Math.max(0, this.usedBytes - n);
    }

    snapshot() {
      return {
        limitBytes: this.limitBytes,
        limitMiB: Number.isFinite(this.limitBytes) ? this.limitBytes / MI_BYTES : null,
        usedBytes: this.usedBytes,
        peakBytes: this.peakBytes,
        categories: { ...this.categories },
        categoryPeaks: { ...this.categoryPeaks },
        limitText: formatBytes(this.limitBytes),
        usedText: formatBytes(this.usedBytes),
        peakText: formatBytes(this.peakBytes),
      };
    }
  }

  /* ------------------------------- joins ------------------------------ */

  function* rangeSource(rel, start, end) {
    for (let i = start; i < end; i += 1) yield rel.rows[i];
  }

  function unifyAtom(atom, tuple, env) {
    if (atom.args.length !== tuple.length) return null;
    let nextEnv = env;
    for (let i = 0; i < atom.args.length; i += 1) {
      const arg = atom.args[i];
      const value = tuple[i];
      if (arg.kind === 'const') {
        if (!valuesEqual(arg.value, value)) return null;
      } else {
        const name = arg.name;
        if (Object.prototype.hasOwnProperty.call(nextEnv, name)) {
          if (!valuesEqual(nextEnv[name], value)) return null;
        } else {
          nextEnv = { ...nextEnv, [name]: value };
        }
      }
    }
    return nextEnv;
  }

  function projectHead(head, env) {
    return head.args.map((arg) => {
      if (arg.kind === 'const') return arg.value;
      if (!Object.prototype.hasOwnProperty.call(env, arg.name)) {
        throw new Error(`内部错误: 头部变量 ${arg.name} 未绑定；安全检查应已阻止此规则`);
      }
      return env[arg.name];
    });
  }

  function joinRule(rule, sourceForAtom, hooks) {
    const body = rule.body;

    function walk(index, env) {
      if (index === body.length) {
        const tuple = projectHead(rule.head, env);
        if (hooks && hooks.onTuple) hooks.onTuple(tuple);
        return;
      }

      const atom = body[index];
      const source = sourceForAtom(atom, index);
      for (const tuple of source) {
        if (hooks && hooks.onRow) hooks.onRow(index, atom);
        const nextEnv = unifyAtom(atom, tuple, env);
        if (nextEnv) walk(index + 1, nextEnv);
      }
    }

    walk(0, {});
  }

  function maskLabel(mask, occurrenceCount) {
    if (occurrenceCount === 0) return 'EDB';
    const bits = [];
    for (let i = 0; i < occurrenceCount; i += 1) bits.push(mask & (1 << i) ? 'Δ' : 'old');
    return bits.join(' ⋈ ');
  }

  /* --------------------------- naive evaluator ------------------------ */

  function makeInitialRound(model) {
    const counts = {};
    for (const [name, p] of model.predicates) {
      counts[name] = (model.tables.get(name) || []).length;
    }
    return { round: 0, kind: 'initial', counts, newCounts: { ...counts }, totalTuples: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  function evaluateNaiveModel(model, options = {}) {
    const started = nowMs();
    const maxRounds = options.maxRounds || 2000;
    const report = {
      engine: 'naive',
      ok: true,
      termination: null,
      error: null,
      rounds: [makeInitialRound(model)],
      finalRelations: {},
      finalCounts: {},
      totals: { passes: 0, candidates: 0, rowsScanned: 0, ruleCalls: 0, newTuples: 0 },
      durationMs: 0,
    };

    const rels = new Map();
    for (const [name, p] of model.predicates) {
      const map = new Map();
      for (const row of model.tables.get(name) || []) map.set(tupleKey(name, row), row.slice());
      rels.set(name, map);
    }

    try {
      let passNo = 1;
      while (passNo <= maxRounds) {
        const t0 = nowMs();
        const pending = new Map();
        const pass = {
          round: passNo,
          kind: 'naive-pass',
          countsBefore: Object.fromEntries([...rels].map(([n, m]) => [n, m.size])),
          countsAfter: {},
          newCounts: {},
          newTuples: {},
          candidates: 0,
          duplicates: 0,
          rowsScanned: 0,
          ruleCalls: 0,
          perRule: [],
          durationMs: 0,
        };

        for (const rule of model.rules) {
          pass.ruleCalls += 1;
          report.totals.ruleCalls += 1;
          const ruleStat = { id: rule.id, head: formatAtom(rule.head), candidates: 0, rowsScanned: 0 };
          joinRule(
            rule,
            (atom) => rels.get(atom.name).values(),
            {
              onRow: () => { pass.rowsScanned += 1; ruleStat.rowsScanned += 1; },
              onTuple: (tuple) => {
                pass.candidates += 1;
                ruleStat.candidates += 1;
                report.totals.candidates += 1;
                const key = tupleKey(rule.head.name, tuple);
                if (rels.get(rule.head.name).has(key) || pending.has(key)) {
                  pass.duplicates += 1;
                } else {
                  pending.set(key, tuple);
                }
              },
            }
          );
          pass.perRule.push(ruleStat);
        }

        let totalNew = 0;
        for (const [name, map] of rels) {
          pass.countsBefore[name] = pass.countsBefore[name] || 0;
          pass.newCounts[name] = 0;
          pass.newTuples[name] = [];
        }

        for (const [key, tuple] of pending) {
          const name = inferHeadFromKey(key, model);
          const map = rels.get(name);
          if (!map.has(key)) {
            map.set(key, tuple);
            pass.newCounts[name] = (pass.newCounts[name] || 0) + 1;
            pass.newTuples[name].push(tuple);
            totalNew += 1;
          }
        }

        for (const [name, map] of rels) pass.countsAfter[name] = map.size;
        pass.totalNew = totalNew;
        pass.durationMs = nowMs() - t0;
        report.rounds.push(pass);
        report.totals.passes += 1;
        report.totals.rowsScanned += pass.rowsScanned;
        report.totals.newTuples += totalNew;

        if (totalNew === 0) {
          report.termination = `第 ${passNo} 轮完整重算后没有新元组（T(I)=I），达到不动点；有限常量域上的无函数正向 Datalog 必然终止。`;
          break;
        }

        passNo += 1;
        if (passNo > maxRounds) throw new Error(`超过最大轮次 ${maxRounds}，已中止以防止异常输入导致无限执行`);
      }

      for (const [name, map] of rels) {
        const rows = [...map.values()];
        report.finalRelations[name] = sortTuples(rows);
        report.finalCounts[name] = report.finalRelations[name].length;
      }
    } catch (err) {
      report.ok = false;
      report.error = err.message || String(err);
    }

    report.durationMs = nowMs() - started;
    return report;
  }

  // JSON keys include the relation name in the first array element.
  function inferHeadFromKey(key, model) {
    try {
      const parsed = JSON.parse(key);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0];
    } catch (_) { /* fall through */ }
    // Should never happen for engine-generated keys. Search predicates as a fallback.
    for (const name of model.predicates.keys()) if (key.startsWith(JSON.stringify([name]))) return name;
    throw new Error('无法从键识别谓词');
  }

  /* ------------------------ semi-naive evaluator ----------------------- */

  function autoSegmentCapacity(meter) {
    if (!Number.isFinite(meter.limitBytes)) return 8;
    // Keep one candidate batch and one temporary segment index comfortably small.
    const roughEntry = 160;
    const cap = Math.floor(meter.limitBytes / (8 * roughEntry));
    return Math.max(1, Math.min(64, cap));
  }

  function evaluateSemiNaiveModel(model, options = {}) {
    const started = nowMs();
    const dedup = options.dedup === 'segmented' ? 'segmented' : 'full';
    const doubleDelta = options.doubleDelta !== false;
    const meter = new MemoryMeter(options.memoryLimitMiB);
    const maxRounds = options.maxRounds || 2000;

    const report = {
      engine: 'seminaive',
      dedup,
      doubleDelta,
      ok: true,
      termination: null,
      error: null,
      quotaExceeded: null,
      rounds: [makeInitialRound(model)],
      finalRelations: {},
      finalCounts: {},
      totals: {
        passes: 0,
        candidates: 0,
        rowsScanned: 0,
        ruleCalls: 0,
        newTuples: 0,
        deltaDeltaCandidates: 0,
        deltaDeltaNew: 0,
        segmentReviews: 0,
        hashSegmentReviews: 0,
        scalarSegmentReviews: 0,
        recheckedKeys: 0,
        keyComparisons: 0,
      },
      memory: null,
      durationMs: 0,
    };

    let rels = new Map();
    try {
      for (const [name, p] of model.predicates) {
        const rel = {
          name,
          arity: p.arity,
          rows: [],
          oldLength: 0,
          deltaEnd: 0,
          seen: dedup === 'full' ? new Set() : null,
        };

        for (const sourceRow of model.tables.get(name) || []) {
          const row = sourceRow.slice();
          const key = tupleKey(name, row);
          const rowCost = tupleBytes(row);
          const idxCost = dedup === 'full' ? indexEntryBytes(key) : 0;
          meter.check(rowCost + idxCost);
          meter.reserve('relationBytes', rowCost);
          rel.rows.push(row);
          if (dedup === 'full') {
            meter.reserve('fullIndexBytes', idxCost);
            rel.seen.add(key);
          }
        }
        rel.deltaEnd = rel.rows.length;
        rels.set(name, rel);
      }
    } catch (err) {
      report.ok = false;
      report.code = err.code || null;
      report.quotaExceeded = err instanceof MemoryLimitError ? err.message : null;
      report.error = err.message || String(err);
      report.memory = meter.snapshot();
      report.durationMs = nowMs() - started;
      return report;
    }

    const segmentCapacity = Math.max(1, options.segmentCapacity || autoSegmentCapacity(meter));
    const batchers = new Map();
    let activePass = null;

    function addSegmentMetric(metric, n) {
      report.totals[metric] = (report.totals[metric] || 0) + n;
      if (activePass) activePass[metric] = (activePass[metric] || 0) + n;
    }

    function insertFull(relName, tuple, key, term) {
      const rel = rels.get(relName);
      if (rel.seen.has(key)) return false;
      const rowCost = tupleBytes(tuple);
      const idxCost = indexEntryBytes(key);
      // Atomic quota check before mutating either store.
      meter.check(rowCost + idxCost);
      meter.reserve('relationBytes', rowCost);
      meter.reserve('fullIndexBytes', idxCost);
      rel.rows.push(tuple);
      rel.seen.add(key);
      if (term) term.newCount += 1;
      return true;
    }

    function getBatcher(name) {
      if (!batchers.has(name)) batchers.set(name, { items: [], bytes: 0 });
      return batchers.get(name);
    }

    function flushBatcher(relName) {
      const batcher = getBatcher(relName);
      if (!batcher.items.length) return;
      const rel = rels.get(relName);

      if (dedup !== 'segmented') {
        // Defensive: should not be used in full mode.
        for (const item of batcher.items) insertFull(relName, item.tuple, item.key, item.term);
        batcher.items = [];
        batcher.bytes = 0;
        return;
      }

      let unique = null;
      let useHashedBatch = true;
      try {
        unique = new Map();
        for (const item of batcher.items) {
          if (!unique.has(item.key)) {
            meter.reserve('mapIndexBytes', mapEntryOverheadBytes());
            unique.set(item.key, item);
          }
        }
      } catch (err) {
        if (!(err instanceof MemoryLimitError)) throw err;
        // Release any partial map overhead and use O(batch * segments) scalar checks.
        if (unique) {
          const retained = unique.size * mapEntryOverheadBytes();
          if (retained > 0) meter.release('mapIndexBytes', retained);
        }
        unique = null;
        useHashedBatch = false;
      }

      if (!useHashedBatch) {
        for (const item of batcher.items) {
          let duplicate = false;
          for (let start = 0; start < rel.rows.length; start += segmentCapacity) {
            const end = Math.min(rel.rows.length, start + segmentCapacity);
            addSegmentMetric('segmentReviews', 1);
            addSegmentMetric('scalarSegmentReviews', 1);
            for (let i = start; i < end; i += 1) {
              addSegmentMetric('keyComparisons', 1);
              if (item.key === tupleKey(relName, rel.rows[i])) {
                duplicate = true;
                break;
              }
            }
            if (duplicate) break;
          }
          if (!duplicate) {
            const rowCost = tupleBytes(item.tuple);
            meter.reserve('relationBytes', rowCost);
            rel.rows.push(item.tuple);
            if (item.term) item.term.newCount += 1;
          }
        }
      } else {
        for (let start = 0; start < rel.rows.length; start += segmentCapacity) {
          const end = Math.min(rel.rows.length, start + segmentCapacity);
          let segmentCost = 0;
          for (let i = start; i < end; i += 1) {
            segmentCost += indexEntryBytes(tupleKey(relName, rel.rows[i]));
          }

          addSegmentMetric('segmentReviews', 1);
          addSegmentMetric('recheckedKeys', end - start);

          if (meter.availableBytes() >= segmentCost) {
            meter.reserve('tempIndexBytes', segmentCost);
            const segSet = new Set();
            for (let i = start; i < end; i += 1) segSet.add(tupleKey(relName, rel.rows[i]));
            addSegmentMetric('hashSegmentReviews', 1);

            const keys = [...unique.keys()];
            for (const key of keys) {
              if (segSet.has(key)) {
                const item = unique.get(key);
                unique.delete(key);
                meter.release('mapIndexBytes', mapEntryOverheadBytes());
                if (item && item.term) item.term.duplicateCount = (item.term.duplicateCount || 0) + 1;
              }
            }
            meter.release('tempIndexBytes', segmentCost);
          } else {
            addSegmentMetric('scalarSegmentReviews', 1);
            const entries = [...unique.entries()];
            for (const [key] of entries) {
              let found = false;
              for (let i = start; i < end; i += 1) {
                addSegmentMetric('keyComparisons', 1);
                if (key === tupleKey(relName, rel.rows[i])) {
                  found = true;
                  break;
                }
              }
              if (found) {
                unique.delete(key);
                meter.release('mapIndexBytes', mapEntryOverheadBytes());
              }
            }
          }

          if (unique.size === 0) break;
        }

        for (const [key, item] of unique) {
          // It may have been deleted during iteration? Map iterator entries snapshot via for..of Map
          // visits current entries; deleted entries are skipped safely.
          if (!item) continue;
          const rowCost = tupleBytes(item.tuple);
          meter.reserve('relationBytes', rowCost);
          rel.rows.push(item.tuple);
          if (item.term) item.term.newCount += 1;
          meter.release('mapIndexBytes', mapEntryOverheadBytes());
        }
      }

      for (const item of batcher.items) meter.release('bufferBytes', item.bytes);
      batcher.items = [];
      batcher.bytes = 0;
    }

    function offerCandidate(relName, tuple, term) {
      const key = tupleKey(relName, tuple);
      if (dedup === 'full') {
        insertFull(relName, tuple, key, term);
        return;
      }

      const batcher = getBatcher(relName);
      if (batcher.items.length >= segmentCapacity) flushBatcher(relName);

      const bytes = tupleBytes(tuple)
        + COSTS.stringHeader + textByteLength(key)
        + COSTS.arraySlot + 48;
      try {
        meter.reserve('bufferBytes', bytes);
      } catch (err) {
        if (!(err instanceof MemoryLimitError)) throw err;
        flushBatcher(relName);
        meter.reserve('bufferBytes', bytes);
      }
      batcher.items.push({ tuple, key, bytes, term });
      batcher.bytes += bytes;

      if (batcher.items.length >= segmentCapacity) flushBatcher(relName);
    }

    function snapshotFinalSafe() {
      const out = {};
      if (!rels) return out;
      for (const [name, rel] of rels) out[name] = sortTuples(rel.rows.map((r) => r.slice()));
      return out;
    }

    try {
      let passNo = 1;
      while (passNo <= maxRounds) {
        const t0 = nowMs();
        activePass = {
          round: passNo,
          kind: 'seminaive-pass',
          inputDeltaCounts: {},
          startCounts: {},
          countsAfter: {},
          newCounts: {},
          newTuples: {},
          totalInputDelta: 0,
          totalNew: 0,
          candidates: 0,
          rowsScanned: 0,
          ruleCalls: 0,
          deltaDeltaCandidates: 0,
          deltaDeltaNew: 0,
          segmentReviews: 0,
          hashSegmentReviews: 0,
          scalarSegmentReviews: 0,
          recheckedKeys: 0,
          keyComparisons: 0,
          terms: [],
          durationMs: 0,
        };
        report.rounds.push(activePass);

        const startLengths = new Map();
        for (const [name, rel] of rels) {
          startLengths.set(name, rel.rows.length);
          activePass.startCounts[name] = rel.rows.length;
          const deltaCount = Math.max(0, rel.deltaEnd - rel.oldLength);
          activePass.inputDeltaCounts[name] = deltaCount;
          activePass.totalInputDelta += deltaCount;
        }

        for (const rule of model.rules) {
          activePass.ruleCalls += 1;
          report.totals.ruleCalls += 1;

          const recursiveOccurrences = [];
          rule.body.forEach((atom, index) => {
            const p = model.predicates.get(atom.name);
            if (p && p.recursive) recursiveOccurrences.push(index);
          });
          const occCount = recursiveOccurrences.length;
          const masks = occCount === 0
            ? [0]
            : Array.from({ length: (1 << occCount) - 1 }, (_, i) => i + 1)
              .filter((mask) => doubleDelta || popcount(mask) === 1);

          for (const mask of masks) {
            // Constant/EDB-only rules are independent of deltas and run only on pass 1.
            if (occCount === 0 && passNo !== 1) continue;

            let skip = false;
            if (occCount > 0) {
              recursiveOccurrences.forEach((atomIndex, occOrdinal) => {
                const atom = rule.body[atomIndex];
                const rel = rels.get(atom.name);
                const usesDelta = (mask & (1 << occOrdinal)) !== 0;
                if (usesDelta && rel.deltaEnd - rel.oldLength === 0) skip = true;
              });
            }
            if (skip) continue;

            const term = {
              ruleId: rule.id,
              head: formatAtom(rule.head),
              mask,
              label: maskLabel(mask, occCount),
              doubleDelta: popcount(mask) >= 2,
              candidates: 0,
              newCount: 0,
              rowsScanned: 0,
            };
            activePass.terms.push(term);

            joinRule(
              rule,
              (atom) => {
                const atomIndex = rule.body.indexOf(atom);
                const occOrdinal = recursiveOccurrences.indexOf(atomIndex);
                const rel = rels.get(atom.name);
                const p = model.predicates.get(atom.name);
                if (!p.recursive) return rangeSource(rel, 0, rel.rows.length);

                const usesDelta = (mask & (1 << occOrdinal)) !== 0;
                return usesDelta
                  ? rangeSource(rel, rel.oldLength, rel.deltaEnd)
                  : rangeSource(rel, 0, rel.oldLength);
              },
              {
                onRow: () => {
                  activePass.rowsScanned += 1;
                  term.rowsScanned += 1;
                  report.totals.rowsScanned += 1;
                },
                onTuple: (tuple) => {
                  activePass.candidates += 1;
                  term.candidates += 1;
                  report.totals.candidates += 1;
                  if (term.doubleDelta) {
                    activePass.deltaDeltaCandidates += 1;
                    report.totals.deltaDeltaCandidates += 1;
                  }
                  offerCandidate(rule.head.name, tuple, term);
                },
              }
            );
          }
        }

        if (dedup === 'segmented') {
          for (const name of batchers.keys()) flushBatcher(name);
        }

        const deltaDeltaNew = activePass.terms
          .filter((term) => term.doubleDelta)
          .reduce((sum, term) => sum + term.newCount, 0);
        activePass.deltaDeltaNew = deltaDeltaNew;
        report.totals.deltaDeltaNew += deltaDeltaNew;

        let totalNew = 0;
        for (const [name, rel] of rels) {
          const start = startLengths.get(name);
          const fresh = rel.rows.slice(start);
          activePass.newCounts[name] = fresh.length;
          activePass.newTuples[name] = fresh.map((r) => r.slice());
          activePass.countsAfter[name] = rel.rows.length;
          totalNew += fresh.length;

          // F^passStart becomes the old snapshot for the next differential round.
          rel.oldLength = start;
          rel.deltaEnd = rel.rows.length;
        }

        activePass.totalNew = totalNew;
        activePass.durationMs = nowMs() - t0;
        report.totals.passes += 1;
        report.totals.newTuples += totalNew;

        if (totalNew === 0) {
          report.termination = `Δ${passNo} 为空：所有非空差分项均未产生未见过的元组，因此 T(I)=I，第 ${passNo} 轮后终止。环上的重复路径由去重集合/分段复核拦截。`;
          break;
        }

        passNo += 1;
        if (passNo > maxRounds) throw new Error(`超过最大轮次 ${maxRounds}，已中止`);
      }

      report.finalRelations = snapshotFinalSafe();
      for (const [name, rows] of Object.entries(report.finalRelations)) report.finalCounts[name] = rows.length;
      report.ok = true;
    } catch (err) {
      report.ok = false;
      report.error = err.message || String(err);
      if (err instanceof MemoryLimitError) {
        report.code = 'MEMORY_LIMIT';
        report.quotaExceeded = err.message;
        report.termination = 'memory-limit';
      }
      report.finalRelations = snapshotFinalSafe();
      for (const [name, rows] of Object.entries(report.finalRelations || {})) report.finalCounts[name] = rows.length;
    }

    const mem = meter.snapshot();
    mem.dedup = dedup;
    mem.segmentCapacity = segmentCapacity;
    mem.persistentDedupIndexBytes = dedup === 'full' ? mem.categories.fullIndexBytes || 0 : 0;
    mem.persistentDedupIndexEntries = dedup === 'full'
      ? [...rels.values()].reduce((n, rel) => n + (rel.seen ? rel.seen.size : 0), 0)
      : 0;
    mem.retainedDedupIndexText = formatBytes(mem.persistentDedupIndexBytes);
    mem.peakText = formatBytes(mem.peakBytes);
    mem.usedText = formatBytes(mem.usedBytes);
    mem.limitText = formatBytes(mem.limitBytes);
    report.memory = { ...mem, metrics: { ...report.totals } };
    report.durationMs = nowMs() - started;
    return report;
  }

  function popcount(x) {
    let n = x;
    let c = 0;
    while (n) { c += n & 1; n >>= 1; }
    return c;
  }

  /* --------------------------- comparison API ------------------------- */

  function relationKeySet(rows) {
    return new Set((rows || []).map((row) => tupleKey('', row)));
  }

  function diffRelation(name, expectedRows, actualRows) {
    const expected = relationKeySet(expectedRows);
    const actual = relationKeySet(actualRows);
    const missing = [];
    const extra = [];
    for (const row of expectedRows || []) {
      if (!actual.has(tupleKey('', row))) missing.push(row);
    }
    for (const row of actualRows || []) {
      if (!expected.has(tupleKey('', row))) extra.push(row);
    }
    return {
      name,
      equal: missing.length === 0 && extra.length === 0,
      missing: sortTuples(missing),
      extra: sortTuples(extra),
      expectedCount: expected.size,
      actualCount: actual.size,
    };
  }

  function compareFinalRelations(naive, candidate) {
    const names = new Set([...Object.keys(naive.finalRelations || {}), ...Object.keys(candidate.finalRelations || {})]);
    const diffs = [];
    let equal = true;
    for (const name of names) {
      const d = diffRelation(name, naive.finalRelations[name] || [], candidate.finalRelations[name] || []);
      diffs.push(d);
      if (!d.equal) equal = false;
    }
    return { equal, diffs };
  }

  function runComparison(text, options = {}) {
    const parsed = parseProgram(text);
    const model = compileProgram(parsed);
    const naive = evaluateNaiveModel(model, options);
    const full = evaluateSemiNaiveModel(model, { ...options, dedup: 'full' });
    const segmented = evaluateSemiNaiveModel(model, { ...options, dedup: 'segmented' });
    let flawed = null;
    if (options.includeFlawed !== false) {
      flawed = evaluateSemiNaiveModel(model, { ...options, dedup: 'full', doubleDelta: false, memoryLimitMiB: 0 });
    }
    const fullCheck = compareFinalRelations(naive, full);
    const segmentedCheck = compareFinalRelations(naive, segmented);
    const flawedCheck = flawed ? compareFinalRelations(naive, flawed) : null;
    return {
      model,
      naive,
      full,
      segmented,
      flawed,
      checks: { full: fullCheck, segmented: segmentedCheck, flawed: flawedCheck },
    };
  }

  return {
    MI_BYTES,
    ParseError,
    MemoryLimitError,
    parseProgram,
    compileProgram,
    evaluateNaiveModel,
    evaluateSemiNaiveModel,
    runComparison,
    compareFinalRelations,
    diffRelation,
    tupleKey,
    sortTuples,
    formatValue,
    formatTuple,
    formatAtom,
    formatBytes,
    tupleBytes,
    indexEntryBytes,
    MemoryMeter,
  };
});
