/* global FixpointEngine, FixpointSamples */
(function () {
  'use strict';

  const E = FixpointEngine;
  const S = FixpointSamples;

  const state = {
    cmp: null,
    selectedSampleId: S.samples[0].id,
    selectedRel: null,
    finalSource: 'naive',
    showAllRows: false,
    renderLimit: 200,
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMs(n) {
    if (n === undefined || n === null || Number.isNaN(n)) return '—';
    if (n < 0.05) return '<0.1 ms';
    return `${n.toFixed(n < 10 ? 1 : 0)} ms`;
  }

  function fmtInt(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  function pct(part, whole) {
    if (!whole) return '0%';
    return `${Math.round((part / whole) * 100)}%`;
  }

  function sampleById(id) {
    return S.samples.find((s) => s.id === id) || S.samples[0];
  }

  function initSamples() {
    const select = $('sampleSelect');
    select.innerHTML = S.samples
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`)
      .join('');
    select.value = state.selectedSampleId;
    loadSelectedSample(false);

    select.addEventListener('change', () => {
      state.selectedSampleId = select.value;
      const sample = sampleById(state.selectedSampleId);
      $('sampleDescription').textContent = sample.description;
    });

    $('loadSampleBtn').addEventListener('click', () => loadSelectedSample(true));
    $('resetSampleBtn').addEventListener('click', () => loadSelectedSample(true));
  }

  function loadSelectedSample(andRun) {
    const sample = sampleById(state.selectedSampleId);
    $('sampleSelect').value = sample.id;
    $('codeEditor').value = sample.code;
    $('memoryLimit').value = sample.memoryLimitMiB === undefined ? '1' : String(sample.memoryLimitMiB);
    $('sampleDescription').textContent = sample.description;
    state.showAllRows = false;
    state.selectedRel = null;
    $('parseError').hidden = true;
    if (andRun) runProgram();
  }

  function initTheme() {
    const root = document.documentElement;
    let saved = null;
    try { saved = localStorage.getItem('fixpoint-theme'); } catch (_) { /* ignore */ }
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

    $('themeToggle').addEventListener('click', () => {
      const darkNow = root.dataset.theme === 'dark'
        || (!root.dataset.theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const next = darkNow ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('fixpoint-theme', next); } catch (_) { /* ignore */ }
    });
  }

  function setRunning(running) {
    const btn = $('runBtn');
    btn.disabled = running;
    btn.innerHTML = running
      ? '运行中…'
      : '运行并对照 <span class="kbd">Ctrl/⌘ + Enter</span>';
  }

  function runProgram() {
    const code = $('codeEditor').value;
    const quotaRaw = parseFloat($('memoryLimit').value);
    const quota = Number.isFinite(quotaRaw) && quotaRaw > 0 ? quotaRaw : 0;

    $('parseError').hidden = true;
    setRunning(true);

    window.setTimeout(() => {
      try {
        state.cmp = E.runComparison(code, {
          memoryLimitMiB: quota,
          includeFlawed: true,
          maxRounds: 3000,
        });
        const names = [...state.cmp.model.predicates.keys()];
        state.selectedRel = names.includes('bridge') ? 'bridge' : names.find((n) => state.cmp.naive.finalCounts[n] > 0) || names[0];
        state.finalSource = 'naive';
        state.showAllRows = false;
        renderAll();
      } catch (err) {
        state.cmp = null;
        $('summaryCards').innerHTML = '';
        $('bannerSlot').innerHTML = '';
        $('memoryContent').innerHTML = '';
        $('deltaContent').innerHTML = '';
        $('roundsContent').innerHTML = '';
        $('finalContent').innerHTML = '';
        const box = $('parseError');
        box.hidden = false;
        box.textContent = err && err.message ? err.message : String(err);
      } finally {
        setRunning(false);
      }
    }, 30);
  }

  function renderAll() {
    renderSummary();
    renderBanner();
    renderMemory();
    renderDelta();
    renderRounds();
    renderFinal();
  }

  function totalFinalTuples(report) {
    return Object.values(report.finalCounts || {}).reduce((a, b) => a + b, 0);
  }

  function renderSummary() {
    const { naive, full, segmented } = state.cmp;
    const naiveScans = naive.totals.rowsScanned;
    const snScans = segmented.ok ? segmented.totals.rowsScanned : full.totals.rowsScanned;
    const reduction = naiveScans > 0 ? Math.max(0, Math.round((1 - snScans / naiveScans) * 100)) : 0;
    const ddNew = full.ok ? full.totals.deltaDeltaNew : segmented.totals.deltaDeltaNew;
    const peakText = segmented.memory ? segmented.memory.peakText : '—';
    const fullPeak = full.memory ? full.memory.peakText : '—';

    const cards = [
      ['最终元组', fmtInt(totalFinalTuples(naive)), `${Object.keys(naive.finalCounts).length} 个谓词`],
      ['执行轮次', `${naive.totals.passes} / ${segmented.totals.passes}`, '朴素完整重算 / 半朴素差分'],
      ['扫描量下降', `${reduction}%`, `${fmtInt(naiveScans)} → ${fmtInt(snScans)} 次原子扫描`],
      ['Δ⋈Δ 新推导', fmtInt(ddNew), '两侧同轮新增均被保留'],
      ['峰值逻辑内存', peakText, `全量索引模式：${fullPeak}`],
    ];

    $('summaryCards').innerHTML = cards.map(([label, value, note]) => `
      <article class="stat-card">
        <span class="stat-label">${esc(label)}</span>
        <span class="stat-value">${esc(value)}</span>
        <div class="stat-note">${esc(note)}</div>
      </article>
    `).join('');
  }

  function equalityBadge(report, check) {
    if (!report.ok || report.code === 'MEMORY_LIMIT') return '<span class="badge critical">⚠ 内存限额中止</span>';
    if (check && check.equal) return '<span class="badge good">✓ 完成且集合一致</span>';
    return '<span class="badge critical">≠ 最终集合不一致</span>';
  }

  function renderBanner() {
    const { checks, full, segmented } = state.cmp;
    let cls = 'good';
    let icon = '✓';
    let title = '三方最终关系完全一致';
    let body = '朴素全量执行、全量去重索引半朴素执行、分段复核半朴素执行得到相同关系集合。';

    if (!segmented.ok && segmented.code === 'MEMORY_LIMIT') {
      cls = 'critical'; icon = '⚠';
      title = '分段复核也超过了当前内存限额';
      body = `朴素参考结果仍已完成。提高限额后可重跑；分段模式能省去常驻全量索引，但无法消除最终关系本身的存储。${esc(segmented.quotaExceeded || segmented.error || '')}`;
    } else if (!full.ok && full.code === 'MEMORY_LIMIT' && checks.segmented.equal) {
      cls = 'warning'; icon = '⚠';
      title = '全量索引触顶；分段复核完成且与朴素结果一致';
      body = '这正是限额下的策略差异：全量 Set 无法保留，分段临时复核用额外扫描换来了更低常驻内存。';
    } else if (checks.segmented.equal && checks.full.equal) {
      cls = 'good';
    } else {
      cls = 'critical'; icon = '≠';
      title = '检测到最终集合差异';
      body = '请在下方“最终关系集合”中查看 missing/extra；通常意味着差分展开或去重实现有误。';
    }

    $('bannerSlot').innerHTML = `
      <div class="banner ${cls}" role="status">
        <span class="icon" aria-hidden="true">${icon}</span>
        <div><strong>${esc(title)}</strong><p>${body}</p></div>
      </div>`;
  }

  function barRow(label, valueText, widthPct, cls, quotaPos) {
    const quota = quotaPos === null || quotaPos === undefined ? '' : `<span class="quota-line" style="left:${quotaPos}%" title="内存限额位置"></span>`;
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(label)}</span>
        <span class="bar-track">
          <span class="bar-fill ${cls || ''}" style="width:${Math.max(1.5, Math.min(100, widthPct)).toFixed(2)}%"></span>
          ${quota}
        </span>
        <span class="bar-value">${esc(valueText)}</span>
      </div>`;
  }

  function renderMemory() {
    const { naive, full, segmented } = state.cmp;
    const qBytes = full.memory && Number.isFinite(full.memory.limitBytes) ? full.memory.limitBytes : null;
    const peakScale = Math.max(
      full.memory ? full.memory.peakBytes : 1,
      segmented.memory ? segmented.memory.peakBytes : 1,
      qBytes || 0,
      1
    ) * 1.08;
    const quotaPos = qBytes ? (qBytes / peakScale) * 100 : null;
    const indexScale = Math.max(full.memory.persistentDedupIndexBytes, 1);

    const peakBars = [
      barRow('全量索引', full.memory.peakText, (full.memory.peakBytes / peakScale) * 100, '', quotaPos),
      barRow('分段复核', segmented.memory.peakText, (segmented.memory.peakBytes / peakScale) * 100, 'aqua', quotaPos),
    ].join('');

    const indexBars = [
      barRow('常驻 Set', E.formatBytes(full.memory.persistentDedupIndexBytes), (full.memory.persistentDedupIndexBytes / indexScale) * 100, '', null),
      barRow('分段常驻', '0 B', 0, 'aqua', null),
    ].join('');

    const rows = [
      {
        name: '朴素全量重算',
        status: '<span class="badge neutral">参考基准</span>',
        peak: '未套用限额',
        persist: '完整 Map',
        reviews: '—',
        comparisons: '—',
        candidates: naive.totals.candidates,
        scans: naive.totals.rowsScanned,
        ms: naive.durationMs,
        equal: '<span class="badge neutral">预言机</span>',
        failed: false,
      },
      {
        name: '半朴素 + 全量去重索引',
        status: full.ok ? '<span class="badge good">✓ 完成</span>' : '<span class="badge critical">⚠ 限额中止</span>',
        peak: full.memory.peakText,
        persist: `${E.formatBytes(full.memory.persistentDedupIndexBytes)} / ${fmtInt(full.memory.persistentDedupIndexEntries)} 键`,
        reviews: '—',
        comparisons: '—',
        candidates: full.totals.candidates,
        scans: full.totals.rowsScanned,
        ms: full.durationMs,
        equal: equalityBadge(full, state.cmp.checks.full),
        failed: !full.ok,
      },
      {
        name: '半朴素 + 分段复核',
        status: segmented.ok ? '<span class="badge good">✓ 完成</span>' : '<span class="badge critical">⚠ 限额中止</span>',
        peak: segmented.memory.peakText,
        persist: `0 B 常驻；段容量 ${segmented.memory.segmentCapacity}`,
        reviews: fmtInt(segmented.totals.segmentReviews),
        comparisons: fmtInt(segmented.totals.keyComparisons),
        candidates: segmented.totals.candidates,
        scans: segmented.totals.rowsScanned,
        ms: segmented.durationMs,
        equal: equalityBadge(segmented, state.cmp.checks.segmented),
        failed: !segmented.ok,
      },
    ];

    const table = `
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>策略</th><th>状态</th><th>峰值逻辑内存</th><th>常驻去重索引</th>
              <th class="num">段复核</th><th class="num">键比较</th><th class="num">候选推导</th>
              <th class="num">扫描</th><th class="num">耗时</th><th>最终集合</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr class="${r.failed ? 'failed-row' : ''}">
                <td><b>${esc(r.name)}</b></td>
                <td>${r.status}</td>
                <td>${esc(r.peak)}</td>
                <td>${esc(r.persist)}</td>
                <td class="num">${esc(r.reviews)}</td>
                <td class="num">${esc(r.comparisons)}</td>
                <td class="num">${fmtInt(r.candidates)}</td>
                <td class="num">${fmtInt(r.scans)}</td>
                <td class="num">${fmtMs(r.ms)}</td>
                <td>${r.equal}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    let note;
    if (qBytes && !full.ok && segmented.ok) {
      const savedBytes = full.memory.persistentDedupIndexBytes;
      note = `<p><b>当前限额 ${E.formatBytes(qBytes)} 落在有效对比区间：</b>全量索引需要保留约 ${esc(E.formatBytes(savedBytes))} 常驻键空间并触发限额；分段复核不保留全局 Set，峰值约 ${esc(segmented.memory.peakText)}，代价是 ${fmtInt(segmented.totals.segmentReviews)} 次段复核。</p>`;
    } else if (segmented.ok && full.ok) {
      const saved = full.memory.persistentDedupIndexBytes;
      note = `<p><b>两种策略均完成。</b>全量索引常驻约 ${esc(E.formatBytes(saved))}；分段模式常驻去重索引为 0，但执行了 ${fmtInt(segmented.totals.segmentReviews)} 次段复核和 ${fmtInt(segmented.totals.keyComparisons)} 次逐键比较。压低左侧限额可观察全量索引失败而分段仍完成的区间。</p>`;
    } else {
      note = `<p>当前限额过紧，连最终关系行或临时候选批也无法容纳。可提高限额；朴素参考执行不受该逻辑限额影响。</p>`;
    }
    note += '<p>注：内存为引擎显式记账的逻辑估算；虚线表示限额位置。分段临时 Set 会在段复核结束后释放。</p>';

    $('memoryContent').innerHTML = `
      <div class="memory-grid">
        <div>
          <p class="bar-group-title">峰值逻辑内存对比</p>
          <div class="bar-list">${peakBars}</div>
          <p class="bar-group-title" style="margin-top:1.1rem;">轮次结束后仍常驻的去重索引</p>
          <div class="bar-list">${indexBars}</div>
        </div>
        <aside class="memory-note">${note}</aside>
      </div>
      <div style="height:.9rem"></div>
      ${table}`;
  }

  function renderDelta() {
    const { full, flawed, checks } = state.cmp;
    const doubleTerms = full.rounds
      .flatMap((r) => r.terms || [])
      .filter((t) => t.doubleDelta && t.candidates > 0);

    const flawedBad = flawed && checks.flawed && !checks.flawed.equal;
    const badDiffs = flawedBad ? checks.flawed.diffs.filter((d) => !d.equal) : [];
    const missing = badDiffs.flatMap((d) => d.missing.map((row) => ({ rel: d.name, row }))).slice(0, 12);

    $('deltaContent').innerHTML = `
      <div class="memory-grid">
        <div class="memory-note" style="border-left-color:var(--aqua); background:var(--aqua-soft);">
          <p><b>正确展开：</b>Δ⋈Δ 候选 <b>${fmtInt(full.totals.deltaDeltaCandidates)}</b> 条，首次采纳 <b>${fmtInt(full.totals.deltaDeltaNew)}</b> 条。</p>
          <p>每个含两个递归原子的规则都会枚举非空差分来源子集，包括 <span class="inline-code">ΔR⋈ΔQ</span>，所以同一轮两侧新增的相接元组不会漏。</p>
          ${doubleTerms.length ? `<p>命中项：${doubleTerms.slice(0, 6).map((t) => `<span class="badge orange" style="color:var(--orange); background:var(--orange-soft); margin:.15rem .25rem .15rem 0;">${esc(t.head)} · ${esc(t.label)} · +${t.newCount}</span>`).join('')}</p>` : ''}
        </div>
        <div class="memory-note" style="border-left-color:var(--critical); background:var(--critical-soft);">
          <p><b>故意漏掉 Δ⋈Δ 的版本：</b>${flawedBad ? '<span class="badge critical">复现漏推导</span>' : '<span class="badge good">本样例未暴露差异</span>'}</p>
          ${flawedBad ? `<p>相对朴素结果缺少：</p><div class="tuple-cloud" style="max-height:150px;">${missing.map((x) => `<span class="tuple-chip">${esc(x.rel)}${esc(E.formatTuple(x.row))}</span>`).join('')}</div>` : '<p>换用默认“环图 + 双递归合取”样例可看到 bridge(a,z) 被漏掉。</p>'}
        </div>
      </div>`;
  }

  function renderRoundInitial(round) {
    return `
      <div class="round-card">
        <div class="round-head" style="cursor:default; grid-template-columns:74px 1fr;">
          <span class="round-title">初始</span>
          <div class="round-metrics">${relationPills(round.counts)}</div>
        </div>
      </div>`;
  }

  function relationPills(counts) {
    return Object.entries(counts || {})
      .filter(([, n]) => n > 0)
      .map(([name, n]) => `<span class="rel-pill">${esc(name)} <b>${fmtInt(n)}</b></span>`)
      .join('');
  }

  function tupleCloud(items, cap = 80) {
    if (!items.length) return '<p class="stat-note">本轮无新增。</p>';
    const shown = items.slice(0, cap);
    const rest = items.length - shown.length;
    return `
      <div class="tuple-cloud">
        ${shown.map((x) => `<span class="tuple-chip" title="${esc(x.rel)}">${esc(x.rel)}${esc(E.formatTuple(x.row))}</span>`).join('')}
      </div>
      ${rest > 0 ? `<p class="stat-note">仅预览前 ${cap} 条，另有 ${rest} 条；请到最终集合查看。</p>` : ''}`;
  }

  function renderRounds() {
    const { naive, segmented, full } = state.cmp;
    const cards = naive.rounds.map((nRound, i) => {
      if (nRound.kind === 'initial' || nRound.round === 0) return renderRoundInitial(nRound);

      const sRound = segmented.rounds[i] || null;
      const fRound = full.rounds[i] || null;
      const terms = (sRound && sRound.terms) || (fRound && fRound.terms) || [];
      const naiveItems = collectTuples(nRound.newTuples);
      const snItems = sRound ? collectTuples(sRound.newTuples) : [];
      const ddNew = sRound ? sRound.deltaDeltaNew : (fRound ? fRound.deltaDeltaNew : 0);
      const open = ddNew > 0 || i === naive.rounds.length - 1 ? ' open' : '';

      return `
        <details class="round-card"${open}>
          <summary class="round-head">
            <span class="round-title">第 ${nRound.round} 轮</span>
            <div class="round-metrics">
              <span>朴素新增 <b>${fmtInt(nRound.totalNew || 0)}</b></span>
              <span>差分新增 <b>${fmtInt(sRound ? sRound.totalNew : 0)}</b></span>
              <span>候选 <b>${fmtInt(nRound.candidates)}</b> / ${fmtInt(sRound ? sRound.candidates : 0)}</span>
              <span>扫描 <b>${fmtInt(nRound.rowsScanned)}</b> / ${fmtInt(sRound ? sRound.rowsScanned : 0)}</span>
              <span>Δ⋈Δ +<b>${fmtInt(ddNew)}</b></span>
              ${sRound ? `<span>段复核 <b>${fmtInt(sRound.segmentReviews)}</b></span>` : ''}
            </div>
            <span class="round-expand">查看明细 ▾</span>
          </summary>
          <div class="round-body">
            <p class="mini-heading">轮后关系总量</p>
            <div class="relation-counts">${relationPills(nRound.countsAfter)}</div>
            <div class="two-col">
              <div>
                <p class="mini-heading">朴素本轮新增</p>
                ${tupleCloud(naiveItems)}
              </div>
              <div>
                <p class="mini-heading">分段半朴素本轮新增</p>
                ${sRound ? tupleCloud(snItems) : '<p class="stat-note">该模式已因内存限额提前停止。</p>'}
              </div>
            </div>
            ${terms.length ? `
              <p class="mini-heading" style="margin-top:.85rem;">差分规则项（仅列产生候选的项）</p>
              <div class="table-scroll">
                <table class="data-table">
                  <thead><tr><th>规则</th><th>old/Δ 展开</th><th class="num">候选</th><th class="num">首次采纳</th><th class="num">扫描</th></tr></thead>
                  <tbody>
                    ${terms.filter((t) => t.candidates > 0).map((t) => `
                      <tr>
                        <td><span class="inline-code">${esc(t.ruleId)} ${esc(t.head)}</span></td>
                        <td><span class="term-label ${t.doubleDelta ? 'double' : ''}">${esc(t.label)}${t.doubleDelta ? ' · 多Δ项' : ''}</span></td>
                        <td class="num">${fmtInt(t.candidates)}</td>
                        <td class="num">${fmtInt(t.newCount)}</td>
                        <td class="num">${fmtInt(t.rowsScanned)}</td>
                      </tr>`).join('')}
                  </tbody>
                </table>
              </div>` : ''}
          </div>
        </details>`;
    }).join('');

    const termination = `
      <div class="banner good" style="box-shadow:none; margin-bottom:.8rem;">
        <span class="icon">■</span>
        <div><strong>终止条件</strong><p>${esc(naive.termination || segmented.termination || '尚未记录')}</p>
        ${segmented.termination && segmented.termination !== naive.termination ? `<p>${esc(segmented.termination)}</p>` : ''}
        </div>
      </div>`;

    $('roundsContent').innerHTML = termination + cards;
  }

  function collectTuples(newTuples) {
    const items = [];
    for (const [rel, rows] of Object.entries(newTuples || {})) {
      for (const row of rows || []) items.push({ rel, row });
    }
    return items;
  }

  function renderFinal() {
    const cmp = state.cmp;
    const names = [...cmp.model.predicates.keys()];
    if (!state.selectedRel || !names.includes(state.selectedRel)) state.selectedRel = names[0];
    const rel = state.selectedRel;
    const predicate = cmp.model.predicates.get(rel);

    const tabs = names.map((name) => `
      <button class="tab-btn" type="button" role="tab"
        data-action="select-rel" data-rel="${esc(name)}"
        aria-selected="${name === rel ? 'true' : 'false'}">
        ${esc(name)} <span style="opacity:.72">${fmtInt(cmp.naive.finalCounts[name] || 0)}</span>
      </button>`).join('');

    const sources = [
      ['naive', '朴素'],
      ['full', '全量索引'],
      ['segmented', '分段复核'],
    ];
    const sourceButtons = sources.map(([id, label]) => `
      <button class="ghost-btn" type="button" data-action="select-source" data-source="${id}"
        aria-pressed="${state.finalSource === id ? 'true' : 'false'}"
        style="${state.finalSource === id ? 'background:var(--ink);color:var(--page);border-color:var(--ink);' : ''}">
        ${label}
      </button>`).join('');

    const report = cmp[state.finalSource] || cmp.naive;
    const allRows = (report.finalRelations && report.finalRelations[rel]) || [];
    const limited = !state.showAllRows && allRows.length > state.renderLimit;
    const rows = limited ? allRows.slice(0, state.renderLimit) : allRows;
    const columns = predicate.columns && predicate.columns.length === predicate.arity
      ? predicate.columns
      : Array.from({ length: predicate.arity }, (_, i) => `c${i + 1}`);

    let sourceCheck = null;
    if (state.finalSource === 'full') sourceCheck = cmp.checks.full;
    if (state.finalSource === 'segmented') sourceCheck = cmp.checks.segmented;
    const diff = sourceCheck ? sourceCheck.diffs.find((d) => d.name === rel) : null;

    const diffHtml = diff && !diff.equal ? `
      <div class="diff-grid" style="margin-bottom:.85rem;">
        <div class="diff-box missing">
          <h3>相对朴素缺少 ${diff.missing.length} 条</h3>
          <div class="tuple-cloud">${diff.missing.slice(0, 100).map((r) => `<span class="tuple-chip">${esc(E.formatTuple(r))}</span>`).join('')}</div>
        </div>
        <div class="diff-box extra">
          <h3>额外 ${diff.extra.length} 条</h3>
          <div class="tuple-cloud">${diff.extra.slice(0, 100).map((r) => `<span class="tuple-chip">${esc(E.formatTuple(r))}</span>`).join('')}</div>
        </div>
      </div>` : '';

    $('finalContent').innerHTML = `
      <div class="tabs" role="tablist" aria-label="谓词选择">${tabs}</div>
      <div class="final-layout">
        <div class="final-toolbar">
          <div class="control-row" style="gap:.4rem;">${sourceButtons}</div>
          <div class="control-row" style="gap:.55rem;">
            ${sourceCheck ? equalityBadge(report, sourceCheck) : '<span class="badge neutral">最终集合基准</span>'}
            <span class="badge blue">${esc(rel)}/${predicate.arity} · ${fmtInt(allRows.length)} 条</span>
            ${limited ? `<button class="secondary-btn" type="button" data-action="show-all">显示全部 ${fmtInt(allRows.length)} 条</button>` : ''}
          </div>
        </div>
        ${diffHtml}
        <div class="final-table-wrap" tabindex="0" aria-label="${esc(rel)} 关系表">
          <table class="data-table">
            <thead>
              <tr><th class="num">#</th>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map((row, idx) => `
                <tr>
                  <td class="num" style="color:var(--muted)">${idx + 1}</td>
                  ${row.map((v) => `<td>${esc(E.formatValue ? E.formatValue(v) : String(v))}</td>`).join('')}
                </tr>`).join('') : `<tr><td colspan="${columns.length + 1}" style="color:var(--muted); text-align:center; padding:1.4rem;">该关系为空，或执行因内存限额提前停止。</td></tr>`}
            </tbody>
          </table>
        </div>
        ${allRows.length > state.renderLimit && state.showAllRows ? '<p class="stat-note">已显示全部元组；虚拟渲染未启用，超大集合可能影响页面流畅度。</p>' : ''}
      </div>`;
  }

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn || !state.cmp) return;
    const action = btn.dataset.action;
    if (action === 'select-rel') {
      state.selectedRel = btn.dataset.rel;
      state.showAllRows = false;
      renderFinal();
    } else if (action === 'select-source') {
      state.finalSource = btn.dataset.source;
      state.showAllRows = false;
      renderFinal();
    } else if (action === 'show-all') {
      state.showAllRows = true;
      renderFinal();
    }
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('memoryLimit').value = btn.dataset.quota;
      document.querySelectorAll('.preset-btn').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      if (state.cmp) runProgram();
    });
  });

  $('runBtn').addEventListener('click', runProgram);
  $('codeEditor').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runProgram();
    }
  });

  initTheme();
  initSamples();
  runProgram();
})();
