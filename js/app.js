/* app.js — 라우터 + 대시보드 + 모달 */
(function () {
  'use strict';
  const { esc, fmtDate } = ERD.util;
  const Store = ERD.Store;

  const viewDash = document.getElementById('view-dash');
  const viewEditor = document.getElementById('view-editor');
  const grid = document.getElementById('dash-grid');
  const countEl = document.getElementById('dash-count');
  const searchEl = document.getElementById('dash-search');
  const fileInput = document.getElementById('file-json');
  const modalRoot = document.getElementById('modal-root');

  /* ---------- 모달 ---------- */
  ERD.modal = function ({ title, body, footer }) {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    ov.innerHTML = `<div class="modal">
      <div class="modal-head"><span>${esc(title)}</span><button class="modal-x" title="닫기">✕</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
    ov.querySelector('.modal-body').append(typeof body === 'string' ? Object.assign(document.createElement('div'), { innerHTML: body }) : body);
    const foot = ov.querySelector('.modal-foot');
    (footer || [{ label: '닫기', onClick: c => c() }]).forEach(f => {
      const b = document.createElement('button');
      b.className = 'btn' + (f.cls ? ' ' + f.cls : '');
      b.textContent = f.label;
      b.addEventListener('click', () => f.onClick(close, b));
      foot.appendChild(b);
    });
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
    ov.querySelector('.modal-x').addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    modalRoot.appendChild(ov);
    return close;
  };

  /* ---------- 대시보드 ---------- */
  function renderDash() {
    const q = (searchEl.value || '').trim().toLowerCase();
    const idx = Store.index()
      .filter(e => !q || (e.name || '').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    countEl.textContent = idx.length ? `${idx.length}개` : '';
    if (!idx.length) {
      grid.innerHTML = `<div class="dash-empty">${q ? '검색 결과가 없습니다.' : 'ERD가 없습니다. 「＋ 새 ERD」 버튼으로 시작하세요.'}</div>`;
      return;
    }
    grid.innerHTML = idx.map(e => `
      <div class="card" data-id="${e.id}">
        <div class="card-name">${esc(e.name) || '(이름 없음)'}</div>
        <div class="card-meta">테이블 ${e.tables || 0}개 · ${fmtDate(e.updatedAt)}</div>
        <div class="card-actions">
          <button class="btn" data-act="rename">이름 변경</button>
          <button class="btn" data-act="dup">복제</button>
          <button class="btn danger" data-act="del">삭제</button>
        </div>
      </div>`).join('');
  }

  grid.addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const btn = e.target.closest('button');
    if (!btn) { location.hash = '#/d/' + id; return; }
    const act = btn.dataset.act;
    if (act === 'del') {
      if (confirm('이 ERD를 삭제할까요? 되돌릴 수 없습니다.')) {
        Store.remove(id);
        renderDash();
      }
    } else if (act === 'dup') {
      Store.duplicate(id);
      renderDash();
    } else if (act === 'rename') {
      const cur = Store.load(id);
      if (!cur) return;
      const name = prompt('새 이름을 입력하세요', cur.name || '');
      if (name === null) return;
      cur.name = name.trim() || cur.name;
      Store.save(cur);
      renderDash();
    }
  });

  searchEl.addEventListener('input', renderDash);

  document.getElementById('btn-new').addEventListener('click', () => {
    const d = Store.create('새 ERD');
    location.hash = '#/d/' + d.id;
  });

  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.tables)) throw new Error('형식 오류');
        const d = Store.create(data.name || file.name.replace(/\.json$/i, ''), data);
        renderDash();
        location.hash = '#/d/' + d.id;
      } catch {
        alert('올바른 ERD JSON 파일이 아닙니다.');
      }
    };
    reader.readAsText(file);
  });

  /* ---------- 라우터 ---------- */
  function route() {
    const m = location.hash.match(/^#\/d\/([^/]+)$/);
    if (m) {
      viewDash.hidden = true;
      viewEditor.hidden = false;
      ERD.Editor.open(m[1]);
    } else {
      ERD.Editor.close();
      viewEditor.hidden = true;
      viewDash.hidden = false;
      document.title = 'ERD CLOUD';
      renderDash();
    }
  }

  window.addEventListener('hashchange', route);

  /* ---------- 시작 ---------- */
  const dl = document.getElementById('dl-types');
  if (dl) dl.innerHTML = ERD.TYPES.map(t => `<option value="${esc(t)}"></option>`).join('');
  ERD.seedIfEmpty();
  route();
})();
