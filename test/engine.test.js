const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../engine.js');
const S = require('../samples.js');

function rows(report, name) {
  return report.finalRelations[name] || [];
}

function keys(report, name) {
  return new Set(rows(report, name).map((r) => r.join('|')));
}

test('cyclic graph terminates with full 3-node reachability', () => {
  const text = S.samples[0].code;
  const cmp = E.runComparison(text, { memoryLimitMiB: 1, includeFlawed: true });

  assert.equal(cmp.naive.ok, true, cmp.naive.error);
  assert.equal(cmp.full.ok, true, cmp.full.error);
  assert.equal(cmp.segmented.ok, true, cmp.segmented.error);

  const reach = keys(cmp.naive, 'reach');
  assert.equal(reach.size, 9);
  for (let x = 1; x <= 3; x += 1) {
    for (let y = 1; y <= 3; y += 1) assert.ok(reach.has(`${x}|${y}`));
  }

  assert.equal(cmp.checks.full.equal, true);
  assert.equal(cmp.checks.segmented.equal, true);
  assert.match(cmp.naive.termination, /不动点/);
  assert.match(cmp.full.termination, /Δ/);
});

test('delta-delta term finds same-round dual-recursive derivation', () => {
  const text = S.samples[0].code;
  const cmp = E.runComparison(text, { memoryLimitMiB: 1, includeFlawed: true });

  const bridge = keys(cmp.segmented, 'bridge');
  assert.deepEqual([...bridge].sort(), [
    'a|b1',
    'a|z',
    'r1|b1',
    'r1|z',
  ]);

  assert.equal(cmp.full.totals.deltaDeltaCandidates > 0, true);
  assert.equal(cmp.full.totals.deltaDeltaNew > 0, true);

  // The intentionally flawed singleton-delta expansion must miss a -> z.
  assert.equal(cmp.flawed.ok, true);
  assert.equal(cmp.checks.flawed.equal, false);
  const missing = cmp.checks.flawed.diffs.find((d) => d.name === 'bridge').missing;
  assert.ok(missing.some((r) => r[0] === 'a' && r[1] === 'z'));
});

test('all bundled samples agree across naive, full index, and segmented recheck', () => {
  for (const sample of S.samples) {
    const cmp = E.runComparison(sample.code, {
      memoryLimitMiB: sample.memoryLimitMiB || 1,
      includeFlawed: false,
    });
    assert.equal(cmp.naive.ok, true, `${sample.id}: ${cmp.naive.error}`);
    assert.equal(cmp.full.ok, true, `${sample.id} full: ${cmp.full.quotaExceeded || cmp.full.error}`);
    assert.equal(cmp.segmented.ok, true, `${sample.id} segmented: ${cmp.segmented.quotaExceeded || cmp.segmented.error}`);
    assert.equal(cmp.checks.full.equal, true, sample.id);
    assert.equal(cmp.checks.segmented.equal, true, sample.id);
  }
});

test('segmented mode performs bounded rechecks without persistent full index', () => {
  const model = E.compileProgram(E.parseProgram(S.buildCrossStress(24)));
  const result = E.evaluateSemiNaiveModel(model, { dedup: 'segmented', memoryLimitMiB: 1 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.finalCounts.pair, 576);
  assert.equal(result.memory.persistentDedupIndexBytes, 0);
  assert.ok(result.totals.segmentReviews > 0);
  assert.ok(result.memory.segmentCapacity >= 1);

  const full = E.evaluateSemiNaiveModel(model, { dedup: 'full', memoryLimitMiB: 16 });
  assert.equal(full.ok, true);
  assert.ok(full.memory.persistentDedupIndexEntries >= 576);
  assert.ok(full.memory.persistentDedupIndexBytes > 0);
});

test('memory quota is enforced and reported instead of crashing', () => {
  const text = S.buildCrossStress(20);
  const model = E.compileProgram(E.parseProgram(text));
  const tiny = E.evaluateSemiNaiveModel(model, { dedup: 'full', memoryLimitMiB: 0.00001 });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.code, 'MEMORY_LIMIT');
  assert.match(tiny.quotaExceeded, /内存限额/);
  assert.ok(tiny.memory.limitBytes > 0);
});

test('nonlinear rule using the same recursive relation twice stays complete', () => {
  const text = `
    table edge(a,b) = {(1,2),(2,3),(3,4),(4,1)}.
    p(X,Y) :- edge(X,Y).
    p(X,Z) :- p(X,Y), p(Y,Z).
  `;
  const cmp = E.runComparison(text, { memoryLimitMiB: 1, includeFlawed: true });
  assert.equal(cmp.naive.ok, true, cmp.naive.error);
  assert.equal(cmp.checks.full.equal, true);
  assert.equal(cmp.checks.segmented.equal, true);
  assert.equal(cmp.naive.finalCounts.p, 16);
  assert.equal(cmp.checks.flawed.equal, false);
});

test('a useful quota band separates full-index failure from segmented completion', () => {
  const model = E.compileProgram(E.parseProgram(S.buildCrossStress(70)));
  const quota = 0.75;
  const full = E.evaluateSemiNaiveModel(model, { dedup: 'full', memoryLimitMiB: quota });
  const segmented = E.evaluateSemiNaiveModel(model, { dedup: 'segmented', memoryLimitMiB: quota });

  assert.equal(full.ok, false);
  assert.equal(full.code, 'MEMORY_LIMIT');
  assert.equal(segmented.ok, true, segmented.error);
  assert.equal(segmented.finalCounts.pair, 4900);
  assert.equal(segmented.memory.persistentDedupIndexBytes, 0);
});

test('parser rejects unsafe unbound head variable', () => {
  assert.throws(
    () => E.compileProgram(E.parseProgram('p(X) :- q(Y). table q(y) = {(1)}.')),
    /没有在正文中安全出现/
  );
});
