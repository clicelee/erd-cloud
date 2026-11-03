/* core.js — 공용 유틸 + localStorage 저장소 + 예제 데이터 */
(function () {
  'use strict';

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const esc = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // 테이블 물리명 (없으면 논리명)
  const phys = t => (t.physicalName || t.name || 'table').trim();

  // 앞쪽에 연속된 PK 컬럼 수 (표시용 구분선 위치)
  const leadPk = cols => {
    let i = 0;
    while (i < cols.length && cols[i].pk) i++;
    return i;
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const fmtDate = ts => {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function download(filename, data) {
    const a = document.createElement('a');
    const isBlob = data instanceof Blob;
    a.href = isBlob ? URL.createObjectURL(data) : data;
    a.download = filename.replace(/[/\\:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (isBlob) setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  /* ---------- 저장소 ---------- */
  const IDX_KEY = 'erdc.index';
  const D_KEY = id => 'erdc.d.' + id;

  // localStorage가 차단된 환경(일부 임베디드 웹뷰 등)에서는 메모리 저장소로 대체
  const LS = (() => {
    try {
      const t = '__erdc_test__';
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
      return window.localStorage;
    } catch {
      console.warn('localStorage 사용 불가 — 메모리 저장소로 동작합니다 (새로고침 시 데이터가 사라집니다)');
      const mem = new Map();
      return {
        getItem: k => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => { mem.set(k, String(v)); },
        removeItem: k => { mem.delete(k); }
      };
    }
  })();

  const Store = {
    index() {
      try { return JSON.parse(LS.getItem(IDX_KEY) || '[]'); }
      catch { return []; }
    },
    _saveIndex(idx) { LS.setItem(IDX_KEY, JSON.stringify(idx)); },
    load(id) {
      try { return JSON.parse(LS.getItem(D_KEY(id)) || 'null'); }
      catch { return null; }
    },
    save(d) {
      d.updatedAt = Date.now();
      try {
        LS.setItem(D_KEY(d.id), JSON.stringify(d));
        const idx = this.index();
        const entry = { id: d.id, name: d.name, updatedAt: d.updatedAt, tables: (d.tables || []).length };
        const i = idx.findIndex(e => e.id === d.id);
        if (i >= 0) idx[i] = entry; else idx.push(entry);
        this._saveIndex(idx);
        return true;
      } catch (err) {
        console.warn('저장 실패:', err);
        return false;
      }
    },
    create(name, data) {
      const now = Date.now();
      const d = Object.assign(
        { tables: [], relations: [], memos: [], view: null },
        data || {},
        { id: uid(), name: name || (data && data.name) || '새 ERD', createdAt: now, updatedAt: now }
      );
      this.save(d);
      return d;
    },
    remove(id) {
      LS.removeItem(D_KEY(id));
      this._saveIndex(this.index().filter(e => e.id !== id));
    },
    duplicate(id) {
      const src = this.load(id);
      if (!src) return null;
      const copy = JSON.parse(JSON.stringify(src));
      delete copy.id;
      return this.create((src.name || 'ERD') + ' 사본', copy);
    }
  };

  /* ---------- 예제 데이터 (첫 방문 시) ---------- */
  function sampleData() {
    const col = (id, label, name, type, o = {}) =>
      Object.assign({ id, label, name, type, pk: false, nn: false, comment: '' }, o);

    return {
      view: { x: 40, y: 24, z: 1 },
      tables: [
        {
          id: 't-users', name: '회원', physicalName: 'users', color: '#3b6fe0', x: 80, y: 150,
          columns: [
            col('c-u-id', '회원ID', 'id', 'BIGINT', { pk: true, nn: true }),
            col('c-u-email', '이메일', 'email', 'VARCHAR(255)', { nn: true, comment: '로그인 이메일' }),
            col('c-u-pw', '비밀번호', 'password', 'VARCHAR(255)', { nn: true }),
            col('c-u-name', '이름', 'name', 'VARCHAR(50)', { nn: true }),
            col('c-u-phone', '휴대폰', 'phone', 'VARCHAR(20)'),
            col('c-u-created', '가입일시', 'created_at', 'DATETIME', { nn: true })
          ]
        },
        {
          id: 't-cate', name: '카테고리', physicalName: 'categories', color: '#3aa76d', x: 820, y: 70,
          columns: [
            col('c-c-id', '카테고리ID', 'id', 'INT', { pk: true, nn: true }),
            col('c-c-name', '카테고리명', 'name', 'VARCHAR(100)', { nn: true }),
            col('c-c-parent', '상위카테고리ID', 'parent_id', 'INT', { fkRel: 'r5', fkSrcId: 'c-c-id' })
          ]
        },
        {
          id: 't-prod', name: '상품', physicalName: 'products', color: '#8a63d2', x: 820, y: 320,
          columns: [
            col('c-p-id', '상품ID', 'id', 'BIGINT', { pk: true, nn: true }),
            col('c-p-cate', '카테고리ID', 'category_id', 'INT', { nn: true, fkRel: 'r4', fkSrcId: 'c-c-id' }),
            col('c-p-name', '상품명', 'name', 'VARCHAR(200)', { nn: true }),
            col('c-p-price', '가격', 'price', 'DECIMAL(10,2)', { nn: true }),
            col('c-p-stock', '재고', 'stock', 'INT', { nn: true }),
            col('c-p-desc', '설명', 'description', 'TEXT'),
            col('c-p-created', '등록일시', 'created_at', 'DATETIME', { nn: true })
          ]
        },
        {
          id: 't-order', name: '주문', physicalName: 'orders', color: '#e0913a', x: 90, y: 490,
          columns: [
            col('c-o-id', '주문ID', 'id', 'BIGINT', { pk: true, nn: true }),
            col('c-o-user', '회원ID', 'user_id', 'BIGINT', { nn: true, fkRel: 'r1', fkSrcId: 'c-u-id' }),
            col('c-o-status', '주문상태', 'status', 'VARCHAR(20)', { nn: true, comment: 'PAID/SHIPPED/DONE/CANCEL' }),
            col('c-o-total', '총금액', 'total_price', 'DECIMAL(10,2)', { nn: true }),
            col('c-o-at', '주문일시', 'ordered_at', 'DATETIME', { nn: true })
          ]
        },
        {
          id: 't-oitem', name: '주문상품', physicalName: 'order_items', color: '#d64545', x: 480, y: 500,
          columns: [
            col('c-oi-order', '주문ID', 'order_id', 'BIGINT', { pk: true, nn: true, fkRel: 'r2', fkSrcId: 'c-o-id' }),
            col('c-oi-prod', '상품ID', 'product_id', 'BIGINT', { pk: true, nn: true, fkRel: 'r3', fkSrcId: 'c-p-id' }),
            col('c-oi-qty', '수량', 'quantity', 'INT', { nn: true }),
            col('c-oi-price', '단가', 'unit_price', 'DECIMAL(10,2)', { nn: true })
          ]
        }
      ],
      relations: [
        { id: 'r1', from: 't-users', to: 't-order', identifying: false, many: true },
        { id: 'r2', from: 't-order', to: 't-oitem', identifying: true, many: true },
        { id: 'r3', from: 't-prod', to: 't-oitem', identifying: true, many: true },
        { id: 'r4', from: 't-cate', to: 't-prod', identifying: false, many: true },
        { id: 'r5', from: 't-cate', to: 't-cate', identifying: false, many: true }
      ],
      memos: [
        {
          id: 'm1', x: 470, y: 100, w: 270, h: 150, color: '#fff3a8',
          text: '쇼핑몰 예제 ERD\n\n· 테이블/메모: 상단 버튼으로 추가\n· 관계: 관계 버튼 → 부모 → 자식 클릭\n· 더블클릭: 테이블 이름 수정\n· Delete: 선택 항목 삭제'
        }
      ]
    };
  }

  function seedIfEmpty() {
    try {
      if (!LS.getItem(IDX_KEY)) Store.create('쇼핑몰 예제', sampleData());
    } catch (err) {
      console.warn('예제 생성 실패:', err);
    }
  }

  window.ERD = {
    util: { uid, esc, phys, leadPk, clamp, fmtDate, download },
    Store,
    seedIfEmpty,
    TABLE_COLORS: ['#3b6fe0', '#3aa76d', '#e0913a', '#d64545', '#8a63d2', '#2fa8bf', '#5b6472'],
    MEMO_COLORS: ['#fff3a8', '#ffd9a8', '#d3f2c2', '#cfe6ff', '#f5cfe0'],
    TYPES: [
      'INT', 'BIGINT', 'SMALLINT', 'TINYINT',
      'DECIMAL(10,2)', 'FLOAT', 'DOUBLE', 'BOOLEAN',
      'VARCHAR(20)', 'VARCHAR(50)', 'VARCHAR(100)', 'VARCHAR(255)', 'CHAR(1)',
      'TEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'JSON', 'BLOB'
    ],
    // 캔버스 상수 (CSS와 일치해야 함 — PNG 내보내기에 사용)
    GEO: { HEAD: 42, ROW: 24, PAD: 4, DIV: 5, WORLD: 6000 }
  };
})();
