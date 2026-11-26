(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.FixpointSamples = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const ringDual = `% 样例 1：含环关系图 + 一条同时依赖两个递归关系的规则
% 语法：table 表名(列...) = { (值, ...), ... }.
% 规则：头(变量...) :- 原子, 原子, ... .

table edge(src, dst) = {
  (1, 2),
  (2, 3),
  (3, 1)
}.

% 环上可达性：第一轮得到一跳边，之后每轮只传播上一轮新增路径。
reach(X, Y) :- edge(X, Y).
reach(X, Z) :- reach(X, Y), edge(Y, Z).

table red(a, b) = {
  ('a', 'r1'),
  ('r1', 'm')
}.

table blue(b, c) = {
  ('m', 'b1'),
  ('b1', 'z')
}.

rpath(X, Y) :- red(X, Y).
rpath(X, Z) :- rpath(X, Y), red(Y, Z).

bpath(Y, Z) :- blue(Y, Z).
bpath(X, Z) :- blue(X, Y), bpath(Y, Z).

% bridge 同时依赖 rpath 和 bpath。
% 正确的半朴素展开必须包含 Δrpath ⋈ Δbpath，
% 否则会漏掉两侧在同一轮新增、在中间点 M 相接的元组。
bridge(X, Z) :- rpath(X, M), bpath(M, Z).
`;

  const mutual = `% 样例 2：多个相互递归规则与环
table link(a, b) = {
  ('u1', 'u2'),
  ('u2', 'u3'),
  ('u3', 'u1'),
  ('u3', 'u4')
}.

trusted(X, Y) :- link(X, Y), white(X).
trusted(X, Z) :- trusted(X, Y), link(Y, Z).

white('u1').
white('u2').
white('u3').

% 另一个互相推动的递归关系
jump(X, Y) :- link(X, Y).
jump(X, Z) :- fast(X, Y), jump(Y, Z).
fast(X, Y) :- jump(X, Y), trusted(X, Y).
`;

  const family = `% 样例 3：本地家庭表
table parent(parent, child) = {
  ('alice', 'bob'),
  ('bob', 'carol'),
  ('carol', 'dave'),
  ('dave', 'erin')
}.

ancestor(X, Y) :- parent(X, Y).
ancestor(X, Z) :- parent(X, Y), ancestor(Y, Z).

generation_pair(X, Y) :- ancestor(X, Y).
cousin_chain(X, Z) :- ancestor(X, M), ancestor(M, Z).
`;

  function buildRingStress(n = 36) {
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      rows.push(`  (${i}, ${(i + 1) % n})`);
    }
    return `% 内存/环压力样例：${n} 个节点组成一个环，最终 reach 有 ${n * n} 条。
table edge(src, dst) = {
${rows.join(',\n')}
}.

reach(X, Y) :- edge(X, Y).
reach(X, Z) :- reach(X, Y), edge(Y, Z).
`;
  }

  function buildCrossStress(k = 70) {
    const aRows = [];
    const bRows = [];
    for (let i = 0; i < k; i += 1) {
      aRows.push(`  ('a${String(i).padStart(3, '0')}')`);
      bRows.push(`  ('b${String(i).padStart(3, '0')}')`);
    }
    return `% 内存压力样例：${k} × ${k} = ${k * k} 个 pair 元组，适合观察全量索引与分段复核。
table left(x) = {
${aRows.join(',\n')}
}.

table right(y) = {
${bRows.join(',\n')}
}.

pair(X, Y) :- left(X), right(Y).
`;
  }

  const samples = [
    {
      id: 'ring-dual',
      name: '环图 + 双递归合取',
      description: '小而完整，包含环、多规则和 Δ⋈Δ 关键点。',
      code: ringDual,
      memoryLimitMiB: 1,
    },
    {
      id: 'mutual',
      name: '多递归规则',
      description: '多个递归谓词相互推动。',
      code: mutual,
      memoryLimitMiB: 1,
    },
    {
      id: 'family',
      name: '家庭祖先链',
      description: '线性递归，便于观察轮次增长。',
      code: family,
      memoryLimitMiB: 1,
    },
    {
      id: 'ring-stress',
      name: '环图压力样例',
      description: '36 节点环，1296 条可达关系。',
      code: buildRingStress(36),
      memoryLimitMiB: 0.25,
    },
    {
      id: 'cross-stress',
      name: '内存索引压力样例',
      description: '70×70 派生 4900 条，适合压低内存限额。',
      code: buildCrossStress(70),
      memoryLimitMiB: 2,
    },
  ];

  return { samples, buildRingStress, buildCrossStress };
});
