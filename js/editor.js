/* editor.js — ERD 편집기 */
(function () {
  'use strict';
  const { uid, esc, phys, leadPk, clamp } = ERD.util;
  const GEO = ERD.GEO;
  const STUB = 24;   // 관계선이 테이블에서 수직으로 빠져나오는 길이
  const SNAP = 10;   // 이동 스냅 격자

  const KEY_PK = '<svg width="13" height="13" viewBox="0 0 16 16"><circle cx="5" cy="8" r="3" fill="none" stroke="#c9a227" stroke-width="1.8"/><path d="M8 8h7M12 8v3M15 8v2.5" stroke="#c9a227" stroke-width="1.8" fill="none"/></svg>';
  const KEY_FK = '<svg width="13" height="13" viewBox="0 0 16 16"><circle cx="5" cy="8" r="3" fill="none" stroke="#9aa4b2" stroke-width="1.8"/><path d="M8 8h7M12 8v3M15 8v2.5" stroke="#9aa4b2" stroke-width="1.8" fill="none"/></svg>';

  // DOM
  let wrap, canvas, svg, layer, panel, hintEl, nameInput, zoomPct, saveEl;
  let undoBtn, redoBtn;

  // 상태
  let d = null;                        // 현재 다이어그램
  let view = { x: 60, y: 40, z: 1 };
  let sel = null;                      // {kind:'table'|'memo'|'rel', id}
  let mode = 'select';                 // 'select' | 'rel'
  let relCfg = null, relParent = null;
  let rects = new Map();               // tableId → {x,y,w,h}
  let undoStack = [], redoStack = [], lastTag = null, lastTagTime = 0;
  let saveTimer = null;
  let inited = false;
  let inlineFinish = null;             // 진행 중인 인라인 편집의 커밋 함수
  let typePicker = null;               // 열려 있는 타입 선택 팝업 요소
  let dragMoved = false;               // 직전 포인터 동작이 드래그였는지 (click 억제용)
  let panelOpen = false;               // 속성 패널 표시 여부 (⋯ 버튼으로 열고 닫음)

  const table = id => d.tables.find(t => t.id === id);
  const memo = id => d.memos.find(m => m.id === id);
  const relation = id => d.relations.find(r => r.id === id);
  const isSel = (kind, id) => sel && sel.kind === kind && sel.id === id;
  const active = () => !!d && !document.getElementById('view-editor').hidden
    && !document.querySelector('.modal-ov');

  /* ================= 열기 / 닫기 ================= */
  function open(id) {
    const loaded = ERD.Store.load(id);
    if (!loaded) { location.hash = '#/'; return; }
    if (!inited) init();
    d = loaded;
    d.tables = d.tables || [];
    d.relations = d.relations || [];
    d.memos = d.memos || [];
    view = d.view ? { ...d.view } : { x: 60, y: 40, z: 1 };
    sel = null;
    exitRelMode();
    undoStack = []; redoStack = []; lastTag = null;
    nameInput.value = d.name || '';
    document.title = (d.name || 'ERD') + ' - ERD CLOUD';
    renderAll();
    saveEl.textContent = '';
    syncUndoBtns();
  }

  function close() {
    if (!d) return;
    clearTimeout(saveTimer);
    saveNow();
    d = null;
    document.title = 'ERD CLOUD';
  }

  /* ================= 좌표 ================= */
  const snap = v => Math.round(v / SNAP) * SNAP;
  const clampCoord = v => clamp(v, 0, GEO.WORLD - 240);

  function toWorld(ev) {
    const r = wrap.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.z, y: (ev.clientY - r.top - view.y) / view.z };
  }
  function viewCenterWorld() {
    return { x: (wrap.clientWidth / 2 - view.x) / view.z, y: (wrap.clientHeight / 2 - view.y) / view.z };
  }
  function applyView() {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    zoomPct.textContent = Math.round(view.z * 100) + '%';
  }
  function zoomAt(sx, sy, nz) {
    nz = clamp(nz, 0.2, 2.5);
    const k = nz / view.z;
    view.x = sx - (sx - view.x) * k;
    view.y = sy - (sy - view.y) * k;
    view.z = nz;
    applyView();
    save();
  }
  function fit() {
    const boxes = [...rects.values(), ...d.memos.map(m => ({ x: m.x, y: m.y, w: m.w, h: m.h }))];
    if (!boxes.length) { view = { x: 60, y: 40, z: 1 }; applyView(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    const bw = maxX - minX, bh = maxY - minY;
    // 속성 패널이 열려 있으면 그만큼 가용 폭에서 제외
    const availW = wrap.clientWidth - (panel.hidden ? 0 : 340);
    const z = clamp(Math.min((availW - 100) / bw, (wrap.clientHeight - 100) / bh, 1.4), 0.2, 1.4);
    view.z = z;
    view.x = (availW - bw * z) / 2 - minX * z;
    view.y = (wrap.clientHeight - bh * z) / 2 - minY * z;
    applyView();
    save();
  }

  /* ================= 저장 / 실행취소 ================= */
  function save() {
    if (!d) return;
    clearTimeout(saveTimer);
    saveEl.textContent = '저장 중…';
    saveTimer = setTimeout(saveNow, 250);
  }
  function saveNow() {
    if (!d) return;
    clearTimeout(saveTimer);
    d.view = { ...view };
    const ok = ERD.Store.save(d);
    const t = new Date();
    const p = n => String(n).padStart(2, '0');
    saveEl.textContent = ok === false
      ? '저장 실패 (브라우저 저장소 접근 불가)'
      : `저장됨 ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  }

  const snapshot = () => JSON.stringify(Object.assign({}, d, { view: undefined }));

  function pushUndo(tag) {
    const now = Date.now();
    if (tag && tag === lastTag && now - lastTagTime < 900) { lastTagTime = now; return; }
    lastTag = tag || null;
    lastTagTime = now;
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    syncUndoBtns();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
  }
  function restore(json) {
    const v = view;
    d = Object.assign(JSON.parse(json), { view: { ...v }, id: d.id, name: d.name, createdAt: d.createdAt });
    lastTag = null;
    validateSel();
    renderAll();
    save();
    syncUndoBtns();
  }
  function validateSel() {
    if (!sel) return;
    const ok = sel.kind === 'table' ? table(sel.id) : sel.kind === 'memo' ? memo(sel.id) : relation(sel.id);
    if (!ok) { sel = null; panelOpen = false; }
  }
  function syncUndoBtns() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
  }

  /* ================= 렌더링 ================= */
  function renderAll() {
    renderObjects();
    renderRels();
    renderPanel();
    applyView();
  }

  function renderObjects() {
    typePicker = null; // 레이어가 비워지므로 팝업 참조도 해제
    layer.textContent = '';
    const frag = document.createDocumentFragment();
    d.memos.forEach(m => frag.appendChild(memoEl(m)));
    d.tables.forEach(t => frag.appendChild(tableEl(t)));
    layer.appendChild(frag);
    rects.clear();
    layer.querySelectorAll('.table').forEach(el => {
      rects.set(el.dataset.id, {
        x: parseFloat(el.style.left), y: parseFloat(el.style.top),
        w: el.offsetWidth, h: el.offsetHeight
      });
    });
  }

  function tableEl(t) {
    const el = document.createElement('div');
    el.className = 'table' + (isSel('table', t.id) ? ' sel' : '') + (mode === 'rel' && relParent === t.id ? ' rel-parent' : '');
    el.dataset.id = t.id;
    el.style.left = t.x + 'px';
    el.style.top = t.y + 'px';
    const lead = leadPk(t.columns);
    const rows = t.columns.map((c, i) => {
      const div = (i === lead && lead > 0 && lead < t.columns.length) ? '<div class="t-div"></div>' : '';
      const key = c.pk ? KEY_PK : (c.fkRel ? KEY_FK : '');
      return div + `<div class="t-col${c.label ? ' has-label' : ''}" data-cid="${c.id}">
        <span class="c-grip" title="드래그로 순서 변경">⋮⋮</span>
        <span class="c-key">${key}</span>
        ${c.label ? `<span class="c-label">${esc(c.label)}</span>` : ''}
        <span class="c-name">${esc(c.name)}</span>
        <span class="c-type">${esc(c.type || '')}</span>
        <span class="c-nn">${(c.nn || c.pk) ? 'NN' : ''}</span>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="t-head" style="background:${esc(t.color || '#3b6fe0')}">
        <span class="t-name">${esc(t.name) || '&nbsp;'}</span>
        ${t.physicalName ? `<span class="t-pname">${esc(t.physicalName)}</span>` : ''}
        <button class="t-gear" title="상세 편집 — PK/NN·코멘트·색상·컬럼 관리">⋯</button>
      </div>
      <div class="t-cols">${rows || '<div class="t-empty">컬럼 없음</div>'}</div>`;
    return el;
  }

  function memoEl(m) {
    const el = document.createElement('div');
    el.className = 'memo' + (isSel('memo', m.id) ? ' sel' : '');
    el.dataset.id = m.id;
    el.style.cssText = `left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px;background:${esc(m.color || '#fff3a8')}`;
    el.innerHTML = `<div class="m-bar"><button class="m-gear" title="메모 색상/삭제">⋯</button></div><textarea class="m-text" spellcheck="false" placeholder="메모 입력"></textarea><div class="m-resize"></div>`;
    el.querySelector('.m-text').value = m.text || '';
    return el;
  }

  /* ---------- 관계선 지오메트리 ---------- */
  function anchor(r, other) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const dx = (other.x + other.w / 2) - cx, dy = (other.y + other.h / 2) - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0
        ? { x: r.x + r.w, y: cy, dx: 1, dy: 0 }
        : { x: r.x, y: cy, dx: -1, dy: 0 };
    }
    return dy >= 0
      ? { x: cx, y: r.y + r.h, dx: 0, dy: 1 }
      : { x: cx, y: r.y, dx: 0, dy: -1 };
  }

  function relGeom(r) {
    const ra = rects.get(r.from), rb = rects.get(r.to);
    if (!ra || !rb) return null;
    let pts, a, b;
    if (r.from === r.to) {
      a = { x: ra.x + ra.w, y: ra.y + ra.h * 0.3, dx: 1, dy: 0 };
      b = { x: ra.x + ra.w, y: ra.y + ra.h * 0.7, dx: 1, dy: 0 };
      const ox = ra.x + ra.w + 40;
      pts = [{ x: a.x, y: a.y }, { x: ox, y: a.y }, { x: ox, y: b.y }, { x: b.x, y: b.y }];
    } else {
      a = anchor(ra, rb);
      b = anchor(rb, ra);
      pts = [
        { x: a.x, y: a.y },
        { x: a.x + a.dx * STUB, y: a.y + a.dy * STUB },
        { x: b.x + b.dx * STUB, y: b.y + b.dy * STUB },
        { x: b.x, y: b.y }
      ];
    }
    return {
      pts,
      m1: { x: a.x, y: a.y, dx: a.dx, dy: a.dy, kind: 'one' },
      m2: { x: b.x, y: b.y, dx: b.dx, dy: b.dy, kind: r.many ? 'many' : 'one' }
    };
  }

  const r1 = v => Math.round(v * 10) / 10;
  const dStr = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)} ${r1(p.y)}`).join('');
  function markD(m) {
    const px = -m.dy, py = m.dx;
    if (m.kind === 'one') {
      const t = 11, s = 6;
      return `M${r1(m.x + m.dx * t + px * s)} ${r1(m.y + m.dy * t + py * s)}L${r1(m.x + m.dx * t - px * s)} ${r1(m.y + m.dy * t - py * s)}`;
    }
    const t = 13, s = 7;
    const qx = r1(m.x + m.dx * t), qy = r1(m.y + m.dy * t);
    return `M${qx} ${qy}L${r1(m.x + px * s)} ${r1(m.y + py * s)}M${qx} ${qy}L${r1(m.x)} ${r1(m.y)}M${qx} ${qy}L${r1(m.x - px * s)} ${r1(m.y - py * s)}`;
  }

  function renderRels() {
    svg.innerHTML = d.relations.map(r => {
      const g = relGeom(r);
      if (!g) return '';
      const dash = r.identifying ? '' : ' stroke-dasharray="6 4"';
      return `<g class="rel${isSel('rel', r.id) ? ' sel' : ''}" data-id="${r.id}">
        <path class="rel-hit" d="${dStr(g.pts)}"/>
        <path class="rel-line" d="${dStr(g.pts)}"${dash}/>
        <path class="rel-mark" d="${markD(g.m1)}${markD(g.m2)}"/>
      </g>`;
    }).join('');
  }

  /* ---------- 속성 패널 ---------- */
  function renderPanel() {
    if (!sel || !panelOpen) { panel.hidden = true; return; }
    const st = panel.scrollTop;
    let html = '';
    if (sel.kind === 'table') {
      const t = table(sel.id);
      if (!t) { panel.hidden = true; return; }
      html = panelTable(t);
    } else if (sel.kind === 'rel') {
      const r = relation(sel.id);
      if (!r) { panel.hidden = true; return; }
      html = panelRel(r);
    } else {
      const m = memo(sel.id);
      if (!m) { panel.hidden = true; return; }
      html = panelMemo(m);
    }
    panel.innerHTML = html;
    panel.hidden = false;
    panel.scrollTop = st;
  }

  function panelTable(t) {
    const cols = t.columns.map(c => `
      <div class="p-col" data-cid="${c.id}">
        <div class="r1">
          <input type="text" data-f="label" placeholder="논리명" value="${esc(c.label)}">
          <input type="text" data-f="name" placeholder="물리명" value="${esc(c.name)}">
        </div>
        <div class="r2">
          <input type="text" data-f="type" list="dl-types" placeholder="타입" value="${esc(c.type || '')}">
          <label class="ck"><input type="checkbox" data-f="pk" ${c.pk ? 'checked' : ''}>PK</label>
          <label class="ck"><input type="checkbox" data-f="nn" ${c.nn ? 'checked' : ''}>NN</label>
          <span class="ord">
            <button data-act="col-up" title="위로">↑</button>
            <button data-act="col-down" title="아래로">↓</button>
            <button data-act="col-del" title="컬럼 삭제">✕</button>
          </span>
        </div>
        <input type="text" data-f="comment" placeholder="코멘트" value="${esc(c.comment || '')}">
      </div>`).join('');
    return `
      <div class="p-title">테이블 편집
        <span class="p-title-btns">
          <button class="btn danger" data-act="del-table">삭제</button>
          <button class="btn" data-act="panel-close" title="패널 닫기">✕</button>
        </span>
      </div>
      <label class="p-label">논리명</label>
      <input type="text" data-f="name" value="${esc(t.name)}">
      <label class="p-label">물리명 (SQL 테이블명)</label>
      <input type="text" data-f="physicalName" value="${esc(t.physicalName || '')}">
      <label class="p-label">색상</label>
      <div class="swatches">${ERD.TABLE_COLORS.map(c =>
        `<button class="sw${c === t.color ? ' on' : ''}" data-act="color" data-color="${c}" style="background:${c}"></button>`).join('')}
      </div>
      <div class="p-sub">컬럼 <span>${t.columns.length}개</span></div>
      ${cols}
      <button class="btn p-add" data-act="col-add">＋ 컬럼 추가</button>`;
  }

  function panelRel(r) {
    const p = table(r.from), c = table(r.to);
    return `
      <div class="p-title">관계 편집
        <span class="p-title-btns">
          <button class="btn danger" data-act="del-rel">삭제</button>
          <button class="btn" data-act="panel-close" title="패널 닫기">✕</button>
        </span>
      </div>
      <div class="p-info">
        부모: <b>${esc(p ? p.name || phys(p) : '?')}</b><br>
        자식: <b>${esc(c ? c.name || phys(c) : '?')}</b>
      </div>
      <label class="p-label">카디널리티</label>
      <select data-f="many">
        <option value="1n" ${r.many ? 'selected' : ''}>1 : N</option>
        <option value="11" ${!r.many ? 'selected' : ''}>1 : 1</option>
      </select>
      <label class="p-label" style="margin-top:14px">
        <label class="ck" style="font-size:12px;color:var(--text)">
          <input type="checkbox" data-f="identifying" ${r.identifying ? 'checked' : ''}>
          식별 관계 (FK가 자식 PK에 포함, 실선)
        </label>
      </label>
      <div class="p-block p-info">관계 삭제 시 자동 생성된 FK 컬럼도 함께 삭제됩니다.</div>`;
  }

  function panelMemo(m) {
    return `
      <div class="p-title">메모 편집
        <span class="p-title-btns">
          <button class="btn danger" data-act="del-memo">삭제</button>
          <button class="btn" data-act="panel-close" title="패널 닫기">✕</button>
        </span>
      </div>
      <label class="p-label">색상</label>
      <div class="swatches">${ERD.MEMO_COLORS.map(c =>
        `<button class="sw${c === m.color ? ' on' : ''}" data-act="memo-color" data-color="${c}" style="background:${c}"></button>`).join('')}
      </div>`;
  }

  /* ================= 선택 ================= */
  function select(kind, id) {
    if ((!kind && !sel) || (sel && kind && sel.kind === kind && sel.id === id)) return;
    sel = kind ? { kind, id } : null;
    if (!sel) panelOpen = false;
    else if (sel.kind === 'rel') panelOpen = true; // 관계 옵션은 패널에만 있으므로 자동 표시
    layer.querySelectorAll('.sel').forEach(el => el.classList.remove('sel'));
    if (sel && sel.kind !== 'rel') {
      const el = layer.querySelector(`[data-id="${sel.id}"]`);
      if (el) el.classList.add('sel');
    }
    renderRels();
    renderPanel();
  }

  /* ================= 조작 (추가/삭제/관계) ================= */
  function addTable() {
    pushUndo();
    const c = viewCenterWorld();
    const n = d.tables.length + 1;
    const t = {
      id: uid(), name: '테이블' + n, physicalName: 'table_' + n,
      color: '#3b6fe0',
      x: clampCoord(snap(c.x - 110)), y: clampCoord(snap(c.y - 80)),
      columns: [{ id: uid(), label: '', name: 'id', type: 'BIGINT', pk: true, nn: true, comment: '' }]
    };
    d.tables.push(t);
    renderObjects();
    renderRels();
    sel = null;
    select('table', t.id);
    save();
    // 생성 직후 바로 이름을 입력할 수 있도록 인라인 편집 시작
    const el = layer.querySelector(`.table[data-id="${t.id}"]`);
    if (el) startInlineEdit(t, null, 'name', el.querySelector('.t-name'));
  }

  function addMemo() {
    pushUndo();
    const c = viewCenterWorld();
    const m = {
      id: uid(), x: clampCoord(snap(c.x - 100)), y: clampCoord(snap(c.y - 60)),
      w: 200, h: 120, color: '#fff3a8', text: ''
    };
    d.memos.push(m);
    renderObjects();
    renderRels();
    sel = null;
    select('memo', m.id);
    save();
    const el = layer.querySelector(`.memo[data-id="${m.id}"] .m-text`);
    if (el) el.focus();
  }

  function hasCol(t, name) { return t.columns.some(c => c.name === name); }

  function createRelation(pid, cid) {
    pushUndo();
    const rel = { id: uid(), from: pid, to: cid, identifying: relCfg.identifying, many: relCfg.many };
    d.relations.push(rel);
    const p = table(pid), c = table(cid);
    const pks = p.columns.filter(x => x.pk);
    let ins = rel.identifying ? leadPk(c.columns) : c.columns.length;
    let made = 0;
    for (const pc of pks) {
      let nm = pc.name;
      if (hasCol(c, nm)) nm = phys(p) + '_' + pc.name;
      if (hasCol(c, nm)) nm = pc.name + '_2';
      if (hasCol(c, nm)) continue;
      c.columns.splice(ins++, 0, {
        id: uid(), label: pc.label || '', name: nm, type: pc.type || 'INT',
        pk: rel.identifying, nn: true, comment: '', fkRel: rel.id, fkSrcId: pc.id
      });
      made++;
    }
    exitRelMode();
    renderObjects();
    sel = null;
    select('rel', rel.id);
    save();
    if (!pks.length) toast('부모 테이블에 PK가 없어 FK 컬럼이 생성되지 않았습니다');
    else if (!made) toast('이름이 겹쳐 FK 컬럼을 추가하지 못했습니다');
  }

  function removeRelation(relId) {
    const r = relation(relId);
    if (!r) return;
    const c = table(r.to);
    if (c) c.columns = c.columns.filter(x => x.fkRel !== relId);
    d.relations = d.relations.filter(x => x.id !== relId);
  }

  function deleteSel() {
    if (!sel) return;
    pushUndo();
    if (sel.kind === 'table') {
      const id = sel.id;
      d.relations.filter(r => r.from === id || r.to === id).forEach(r => removeRelation(r.id));
      d.tables = d.tables.filter(t => t.id !== id);
    } else if (sel.kind === 'memo') {
      d.memos = d.memos.filter(m => m.id !== sel.id);
    } else {
      removeRelation(sel.id);
    }
    sel = null;
    renderAll();
    save();
  }

  /* ---------- 관계 생성 모드 ---------- */
  function setRelMode(cfg, btn) {
    if (mode === 'rel' && relCfg && btn && btn.classList.contains('on')) { exitRelMode(); return; }
    exitRelMode();
    mode = 'rel';
    relCfg = cfg;
    relParent = null;
    document.body.classList.add('rel-mode');
    if (btn) btn.classList.add('on');
    hint('① 부모 테이블을 클릭하세요 (Esc 취소)');
  }
  function exitRelMode() {
    mode = 'select';
    relCfg = null;
    relParent = null;
    document.body.classList.remove('rel-mode');
    document.querySelectorAll('#tb-rels .btn.on').forEach(b => b.classList.remove('on'));
    if (layer) layer.querySelectorAll('.rel-parent').forEach(el => el.classList.remove('rel-parent'));
    hint(null);
  }
  function pickRel(id) {
    if (!relParent) {
      relParent = id;
      const el = layer.querySelector(`.table[data-id="${id}"]`);
      if (el) el.classList.add('rel-parent');
      hint('② 자식 테이블을 클릭하세요 (Esc 취소)');
    } else {
      createRelation(relParent, id);
    }
  }

  let toastTimer = null;
  function hint(msg) {
    clearTimeout(toastTimer);
    hintEl.hidden = !msg;
    hintEl.textContent = msg || '';
  }
  function toast(msg) {
    hint(msg);
    toastTimer = setTimeout(() => { if (mode !== 'rel') hint(null); }, 2600);
  }

  /* ================= 드래그 ================= */
  // 일부 입력 장치/합성 이벤트에서 setPointerCapture가 예외를 던질 수 있음
  function capture(el, e) {
    try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }

  function startDrag(e, el, kind) {
    const id = el.dataset.id;
    const item = kind === 'table' ? table(id) : memo(id);
    if (!item) return;
    e.preventDefault();
    const sw = toWorld(e), ox = item.x, oy = item.y;
    let pushed = false, raf = 0;
    capture(el, e);
    const move = ev => {
      const w = toWorld(ev);
      const dx = w.x - sw.x, dy = w.y - sw.y;
      // 클릭이 살짝 밀리지 않도록 화면 기준 3px 임계값 이후부터 이동
      if (!pushed) {
        if (Math.abs(dx) * view.z < 3 && Math.abs(dy) * view.z < 3) return;
        pushUndo();
        pushed = true;
        dragMoved = true;
        el.classList.add('dragging');
      }
      item.x = clampCoord(Math.round(ox + dx));
      item.y = clampCoord(Math.round(oy + dy));
      el.style.left = item.x + 'px';
      el.style.top = item.y + 'px';
      const r = rects.get(id);
      if (r) { r.x = item.x; r.y = item.y; }
      if (kind === 'table' && !raf) {
        raf = requestAnimationFrame(() => { raf = 0; renderRels(); });
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      if (raf) { cancelAnimationFrame(raf); raf = 0; renderRels(); }
      if (pushed) save();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  function startMemoResize(e, el) {
    const m = memo(el.dataset.id);
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    const sw = toWorld(e), ow = m.w, oh = m.h;
    let pushed = false;
    capture(el, e);
    const move = ev => {
      const w = toWorld(ev);
      const nw = clamp(Math.round(ow + w.x - sw.x), 120, 800), nh = clamp(Math.round(oh + w.y - sw.y), 70, 800);
      if (!pushed && (nw !== ow || nh !== oh)) { pushUndo(); pushed = true; }
      if (!pushed) return;
      m.w = nw; m.h = nh;
      el.style.width = nw + 'px';
      el.style.height = nh + 'px';
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (pushed) save();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  /* ================= 인라인 편집 (더블클릭) ================= */
  function startInlineEdit(t, col, field, span) {
    closeTypePicker();
    if (inlineFinish) {
      inlineFinish(true); // 기존 편집을 먼저 커밋 — 렌더링으로 span이 교체되므로 다시 찾는다
      const tEl = layer.querySelector(`.table[data-id="${t.id}"]`);
      if (!tEl) return;
      span = col
        ? tEl.querySelector(`.t-col[data-cid="${col.id}"] .${field === 'label' ? 'c-label' : 'c-name'}`)
        : tEl.querySelector(field === 'physicalName' ? '.t-pname' : '.t-name');
    }
    if (!span) return;
    select('table', t.id);
    const target = col || t;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit';
    input.value = target[field] || '';
    if (field === 'type') input.setAttribute('list', 'dl-types');
    input.style.width = Math.max(60, span.getBoundingClientRect().width / view.z + 24) + 'px';
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      inlineFinish = null;
      const val = input.value.trim();
      if (commit && val !== (target[field] || '')) {
        pushUndo();
        target[field] = val;
        save();
      }
      renderObjects();
      renderRels();
      renderPanel();
    };
    inlineFinish = finish;
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', ev => ev.stopPropagation());
  }

  /* ================= 행 드래그 정렬 ================= */
  function startRowDrag(e, tEl, rowEl) {
    if (!rowEl || !rowEl.dataset.cid) return;
    const t = table(tEl.dataset.id);
    if (!t) return;
    e.preventDefault();
    capture(rowEl, e);
    const colsBox = tEl.querySelector('.t-cols');
    let moved = false;
    const move = ev => {
      moved = true;
      dragMoved = true;
      rowEl.classList.add('row-dragging');
      const y = ev.clientY;
      for (const r of colsBox.querySelectorAll('.t-col')) {
        if (r === rowEl) continue;
        const rc = r.getBoundingClientRect();
        if (y < rc.top || y > rc.bottom) continue;
        // 상대 행의 위/아래 절반 기준으로 삽입 위치 결정
        if (y < rc.top + rc.height / 2) colsBox.insertBefore(rowEl, r);
        else colsBox.insertBefore(rowEl, r.nextSibling);
        break;
      }
    };
    const up = () => {
      rowEl.removeEventListener('pointermove', move);
      rowEl.removeEventListener('pointerup', up);
      rowEl.classList.remove('row-dragging');
      if (moved) {
        const order = [...colsBox.querySelectorAll('.t-col')].map(r => r.dataset.cid);
        const cols = order.map(id => t.columns.find(c => c.id === id)).filter(Boolean);
        if (cols.length === t.columns.length && order.join() !== t.columns.map(c => c.id).join()) {
          pushUndo();
          t.columns = cols;
          save();
        }
        renderObjects();
        renderRels();
        renderPanel();
      }
    };
    rowEl.addEventListener('pointermove', move);
    rowEl.addEventListener('pointerup', up);
  }

  /* ================= 타입 선택 팝업 ================= */
  function closeTypePicker() {
    if (typePicker) {
      typePicker.remove();
      typePicker = null;
    }
  }

  function openTypePicker(tid, cid) {
    closeTypePicker();
    if (inlineFinish) inlineFinish(true);
    const t = table(tid);
    const col = t && t.columns.find(c => c.id === cid);
    if (!col) return;
    select('table', tid);
    const rowEl = layer.querySelector(`.table[data-id="${tid}"] .t-col[data-cid="${cid}"]`);
    if (!rowEl) return;
    const anchorEl = rowEl.querySelector('.c-type') || rowEl;
    const wr = wrap.getBoundingClientRect();
    const ar = anchorEl.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'type-picker';
    el.style.left = Math.round((ar.left - wr.left - view.x) / view.z) + 'px';
    el.style.top = Math.round((ar.bottom - wr.top - view.y) / view.z + 4) + 'px';
    el.innerHTML = `<input class="tp-filter" placeholder="검색 / 직접 입력" spellcheck="false">
      <div class="tp-list"></div>`;
    const listEl = el.querySelector('.tp-list');
    const filterEl = el.querySelector('.tp-filter');
    const renderList = q => {
      const ql = (q || '').trim().toLowerCase();
      const items = ERD.TYPES.filter(x => !ql || x.toLowerCase().includes(ql));
      listEl.innerHTML = items.map(x =>
        `<button class="tp-item${x === (col.type || '') ? ' on' : ''}" data-v="${esc(x)}">${esc(x)}</button>`
      ).join('') || '<div class="tp-none">Enter로 직접 입력</div>';
    };
    renderList('');
    const commit = v => {
      v = (v || '').trim();
      closeTypePicker();
      if (!v || v === col.type) return;
      pushUndo();
      col.type = v;
      renderObjects();
      renderRels();
      renderPanel();
      save();
    };
    el.addEventListener('pointerdown', ev => ev.stopPropagation());
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      const b = ev.target.closest('.tp-item');
      if (b) commit(b.dataset.v);
    });
    filterEl.addEventListener('input', () => renderList(filterEl.value));
    filterEl.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        const v = filterEl.value.trim();
        if (v) commit(v);
        else closeTypePicker();
      } else if (ev.key === 'Escape') {
        closeTypePicker();
      }
    });
    layer.appendChild(el);
    typePicker = el;
    filterEl.focus();
  }

  /* ================= 초기화 (이벤트 바인딩 1회) ================= */
  function init() {
    inited = true;
    wrap = document.getElementById('canvas-wrap');
    canvas = document.getElementById('canvas');
    svg = document.getElementById('rel-layer');
    layer = document.getElementById('obj-layer');
    panel = document.getElementById('panel');
    hintEl = document.getElementById('mode-hint');
    nameInput = document.getElementById('ed-name');
    zoomPct = document.getElementById('tb-zoom-pct');
    saveEl = document.getElementById('save-state');
    undoBtn = document.getElementById('tb-undo');
    redoBtn = document.getElementById('tb-redo');

    /* --- 캔버스: 팬 / 빈 곳 클릭 --- */
    wrap.addEventListener('pointerdown', e => {
      if (!d) return;
      // 빈 곳 클릭 시 진행 중인 인라인 편집 커밋 + 타입 팝업 닫기
      if (typePicker && !e.target.closest('.type-picker')) closeTypePicker();
      if (inlineFinish && !(e.target.classList && e.target.classList.contains('inline-edit'))) {
        inlineFinish(true);
      }
      const empty = e.target === canvas || e.target === wrap;
      if (e.button === 1 || (e.button === 0 && empty)) {
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
        let moved = false;
        capture(wrap, e);
        canvas.classList.add('panning');
        const move = ev => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
          if (moved) { view.x = ox + dx; view.y = oy + dy; applyView(); }
        };
        const up = () => {
          wrap.removeEventListener('pointermove', move);
          wrap.removeEventListener('pointerup', up);
          canvas.classList.remove('panning');
          if (moved) save();
          else if (e.button === 0) { if (mode === 'rel') exitRelMode(); else select(null); }
        };
        wrap.addEventListener('pointermove', move);
        wrap.addEventListener('pointerup', up);
      }
    });

    /* --- 휠: Ctrl=줌, 기본=팬 --- */
    wrap.addEventListener('wheel', e => {
      if (!d) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = wrap.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, view.z * Math.exp(-e.deltaY * 0.0022));
      } else {
        const horiz = e.shiftKey && !e.deltaX;
        view.x -= horiz ? e.deltaY : e.deltaX;
        view.y -= horiz ? 0 : e.deltaY;
        applyView();
        save();
      }
    }, { passive: false });

    /* --- 객체 레이어: 선택/드래그/관계 지정 --- */
    layer.addEventListener('pointerdown', e => {
      if (!d || e.button !== 0) return;
      dragMoved = false;
      if (e.target.closest('.type-picker')) return; // 팝업 내부 클릭은 팝업이 처리
      if (typePicker) closeTypePicker();
      let tEl = e.target.closest('.table');
      let mEl = e.target.closest('.memo');
      // 다른 곳을 누르면 진행 중인 인라인 편집을 먼저 커밋 (DOM이 재생성되므로 다시 찾음)
      if (inlineFinish && !e.target.closest('.inline-edit')) {
        inlineFinish(true);
        if (tEl) tEl = layer.querySelector(`.table[data-id="${tEl.dataset.id}"]`);
        if (mEl) mEl = layer.querySelector(`.memo[data-id="${mEl.dataset.id}"]`);
        if (!tEl && !mEl) return;
      }
      if (mode === 'rel') {
        if (tEl) { e.preventDefault(); pickRel(tEl.dataset.id); }
        return;
      }
      if (tEl) {
        if (e.target.closest('.inline-edit')) return; // 편집 중인 입력은 그대로 둔다
        select('table', tEl.dataset.id);
        const grip = e.target.closest('.c-grip');
        if (grip) startRowDrag(e, tEl, grip.closest('.t-col'));
        else startDrag(e, tEl, 'table');
      } else if (mEl) {
        select('memo', mEl.dataset.id);
        if (e.target.closest('.m-resize')) startMemoResize(e, mEl);
        else if (!e.target.closest('.m-text')) startDrag(e, mEl, 'memo');
      }
    });

    // 더블클릭은 별도 처리하지 않는다 — 첫 클릭이 이미 인라인 편집을 열고,
    // DOM 교체 후의 dblclick은 브라우저가 상위 요소로 재지정할 수 있어 오동작의 원인이 된다.

    // 한 번 클릭으로 바로 편집: 텍스트=인라인 입력, 타입=선택 팝업, ⋯=속성 패널
    layer.addEventListener('click', e => {
      if (!d || mode === 'rel' || dragMoved) return;
      const tEl = e.target.closest('.table');
      const mEl = e.target.closest('.memo');
      if ((tEl && e.target.closest('.t-gear')) || (mEl && e.target.closest('.m-gear'))) {
        panelOpen = true;
        renderPanel();
        return;
      }
      if (!tEl) return;
      const t = table(tEl.dataset.id);
      if (!t) return;
      const rowEl = e.target.closest('.t-col');
      if (e.target.closest('.c-type') && rowEl && rowEl.dataset.cid) {
        openTypePicker(t.id, rowEl.dataset.cid);
        return;
      }
      const span = e.target.closest('.c-label, .c-name, .t-name, .t-pname');
      if (!span) return;
      if (rowEl) {
        const col = t.columns.find(c => c.id === rowEl.dataset.cid);
        if (!col) return;
        startInlineEdit(t, col, span.classList.contains('c-label') ? 'label' : 'name', span);
      } else {
        startInlineEdit(t, null, span.classList.contains('t-pname') ? 'physicalName' : 'name', span);
      }
    });

    // 메모 텍스트 입력
    layer.addEventListener('input', e => {
      if (!e.target.classList.contains('m-text')) return;
      const mEl = e.target.closest('.memo');
      const m = memo(mEl.dataset.id);
      if (!m) return;
      pushUndo('memo-text:' + m.id);
      m.text = e.target.value;
      save();
    });

    /* --- 관계선 클릭 --- */
    svg.addEventListener('pointerdown', e => {
      if (!d || mode === 'rel') return;
      const g = e.target.closest('g.rel');
      if (g) select('rel', g.dataset.id);
    });

    /* --- 속성 패널 (위임) --- */
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('click', onPanelClick);

    /* --- 툴바 --- */
    document.getElementById('tb-table').addEventListener('click', addTable);
    document.getElementById('tb-memo').addEventListener('click', addMemo);
    document.querySelectorAll('#tb-rels .btn').forEach(b => {
      b.addEventListener('click', () => setRelMode({
        identifying: b.dataset.rel.startsWith('id'),
        many: b.dataset.rel.endsWith('1n')
      }, b));
    });
    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    document.getElementById('tb-zoom-in').addEventListener('click', () =>
      zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, view.z * 1.2));
    document.getElementById('tb-zoom-out').addEventListener('click', () =>
      zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, view.z / 1.2));
    zoomPct.addEventListener('click', () =>
      zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1));
    document.getElementById('tb-fit').addEventListener('click', fit);

    nameInput.addEventListener('input', () => {
      pushUndo('dname');
      d.name = nameInput.value;
      document.title = (d.name || 'ERD') + ' - ERD CLOUD';
      save();
    });

    /* --- 내보내기 --- */
    document.getElementById('tb-sql').addEventListener('click', () => {
      saveNow();
      const code = ERD.Export.sql(d);
      const body = document.createElement('div');
      const pre = document.createElement('pre');
      pre.className = 'sql';
      pre.textContent = code;
      body.appendChild(pre);
      ERD.modal({
        title: 'SQL 내보내기 (MySQL DDL)',
        body,
        footer: [
          {
            label: '복사', cls: 'primary', onClick: (close, btn) => {
              navigator.clipboard.writeText(code).then(
                () => { btn.textContent = '복사됨 ✓'; setTimeout(() => btn.textContent = '복사', 1500); },
                () => { btn.textContent = '복사 실패'; }
              );
            }
          },
          {
            label: '.sql 다운로드', onClick: () => {
              ERD.util.download((d.name || 'erd') + '.sql', new Blob([code], { type: 'text/sql' }));
            }
          },
          { label: '닫기', onClick: close => close() }
        ]
      });
    });

    document.getElementById('tb-png').addEventListener('click', () => {
      if (!d.tables.length && !d.memos.length) { toast('내보낼 내용이 없습니다'); return; }
      ERD.Export.png(d, rects, d.relations.map(r => ({ rel: r, g: relGeom(r) })), d.name || 'erd');
    });

    document.getElementById('tb-json').addEventListener('click', () => {
      saveNow();
      ERD.util.download((d.name || 'erd') + '.json',
        new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    });

    /* --- 키보드 --- */
    document.addEventListener('keydown', e => {
      if (!active()) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));
      if (e.key === 'Escape') {
        if (typing) { e.target.blur(); return; }
        if (typePicker) { closeTypePicker(); return; }
        if (mode === 'rel') exitRelMode();
        else select(null);
        return;
      }
      if (typing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSel(); }
    });

    window.addEventListener('beforeunload', () => { if (d) saveNow(); });
  }

  /* ---------- 패널 이벤트 ---------- */
  function onPanelInput(e) {
    const f = e.target.dataset.f;
    if (!f || !sel || !d) return;
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;

    if (sel.kind === 'table') {
      const t = table(sel.id);
      if (!t) return;
      const pc = e.target.closest('.p-col');
      pushUndo(`t:${sel.id}:${f}:${pc ? pc.dataset.cid : '-'}`);
      if (pc) {
        const c = t.columns.find(x => x.id === pc.dataset.cid);
        if (!c) return;
        c[f] = val;
      } else {
        t[f] = val;
      }
      renderObjects();
      renderRels();
      save();
    } else if (sel.kind === 'rel') {
      const r = relation(sel.id);
      if (!r) return;
      pushUndo(`r:${sel.id}:${f}`);
      if (f === 'identifying') {
        r.identifying = val;
        const c = table(r.to);
        if (c) c.columns.forEach(x => { if (x.fkRel === r.id) { x.pk = val; if (val) x.nn = true; } });
      } else if (f === 'many') {
        r.many = val === '1n';
      }
      renderObjects();
      renderRels();
      save();
    }
  }

  function onPanelClick(e) {
    const b = e.target.closest('button');
    if (!b || !sel || !d) return;
    const act = b.dataset.act;
    if (!act) return;

    const t = sel.kind === 'table' ? table(sel.id) : null;
    const pc = b.closest('.p-col');
    const colIdx = t && pc ? t.columns.findIndex(x => x.id === pc.dataset.cid) : -1;

    switch (act) {
      case 'panel-close':
        panelOpen = false;
        renderPanel();
        break;
      case 'del-table':
        if (confirm('테이블을 삭제할까요? 연결된 관계도 함께 삭제됩니다.')) deleteSel();
        break;
      case 'color':
        if (!t) return;
        pushUndo();
        t.color = b.dataset.color;
        renderObjects(); renderRels(); renderPanel(); save();
        break;
      case 'col-add': {
        if (!t) return;
        pushUndo();
        const c = { id: uid(), label: '', name: 'column' + (t.columns.length + 1), type: 'VARCHAR(255)', pk: false, nn: false, comment: '' };
        t.columns.push(c);
        renderObjects(); renderRels(); renderPanel(); save();
        const inp = panel.querySelector(`.p-col[data-cid="${c.id}"] input[data-f="name"]`);
        if (inp) { inp.focus(); inp.select(); }
        break;
      }
      case 'col-del':
        if (!t || colIdx < 0) return;
        pushUndo();
        t.columns.splice(colIdx, 1);
        renderObjects(); renderRels(); renderPanel(); save();
        break;
      case 'col-up':
      case 'col-down': {
        if (!t || colIdx < 0) return;
        const j = act === 'col-up' ? colIdx - 1 : colIdx + 1;
        if (j < 0 || j >= t.columns.length) return;
        pushUndo();
        [t.columns[colIdx], t.columns[j]] = [t.columns[j], t.columns[colIdx]];
        renderObjects(); renderRels(); renderPanel(); save();
        break;
      }
      case 'del-rel':
        if (confirm('관계를 삭제할까요? 자동 생성된 FK 컬럼도 함께 삭제됩니다.')) deleteSel();
        break;
      case 'del-memo':
        deleteSel();
        break;
      case 'memo-color': {
        const m = memo(sel.id);
        if (!m) return;
        pushUndo();
        m.color = b.dataset.color;
        renderObjects(); renderPanel(); save();
        break;
      }
    }
  }

  ERD.Editor = { open, close };
})();
