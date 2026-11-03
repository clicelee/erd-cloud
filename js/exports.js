/* exports.js — SQL(DDL) / PNG 내보내기 */
(function () {
  'use strict';
  const { phys } = ERD.util;
  const GEO = ERD.GEO;

  /* ---------- MySQL DDL 생성 ---------- */
  function sql(d) {
    const q = s => '`' + String(s || '').replace(/`/g, '') + '`';
    const lit = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "''");
    const out = [];

    for (const t of d.tables) {
      const lines = t.columns.map(c => {
        let s = `  ${q(c.name || c.label || 'column')} ${(c.type || 'VARCHAR(255)').trim()}`;
        s += (c.pk || c.nn) ? ' NOT NULL' : ' NULL';
        const cmt = c.comment || c.label;
        if (cmt) s += ` COMMENT '${lit(cmt)}'`;
        return s;
      });
      const pk = t.columns.filter(c => c.pk);
      if (pk.length) lines.push(`  PRIMARY KEY (${pk.map(c => q(c.name)).join(', ')})`);
      const cmt = t.name && t.name !== phys(t) ? ` COMMENT='${lit(t.name)}'` : '';
      out.push(`CREATE TABLE ${q(phys(t))} (\n${lines.join(',\n')}\n)${cmt};`);
    }

    const used = {};
    for (const r of d.relations) {
      const p = d.tables.find(t => t.id === r.from);
      const c = d.tables.find(t => t.id === r.to);
      if (!p || !c) continue;
      const fkCols = c.columns.filter(cc => cc.fkRel === r.id);
      const pairs = fkCols
        .map(cc => {
          const src = p.columns.find(pc => pc.id === cc.fkSrcId);
          return src ? [cc.name, src.name] : null;
        })
        .filter(Boolean);
      if (!pairs.length) continue;
      const base = `fk_${phys(c)}_${phys(p)}`;
      let nm = base, i = 1;
      while (used[nm]) nm = base + '_' + (++i);
      used[nm] = 1;
      out.push(
        `ALTER TABLE ${q(phys(c))}\n` +
        `  ADD CONSTRAINT ${q(nm)} FOREIGN KEY (${pairs.map(x => q(x[0])).join(', ')})\n` +
        `  REFERENCES ${q(phys(p))} (${pairs.map(x => q(x[1])).join(', ')});`
      );
    }
    return out.join('\n\n') + '\n';
  }

  /* ---------- PNG 렌더링 ---------- */
  // rects: Map(tableId → {x,y,w,h}), geoms: [{rel, g:{pts, m1, m2}}]
  function png(d, rects, geoms, filename) {
    const items = [];
    rects.forEach(r => items.push(r));
    (d.memos || []).forEach(m => items.push({ x: m.x, y: m.y, w: m.w, h: m.h }));
    if (!items.length) return null;

    const pad = 48;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of items) {
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    const W = maxX - minX + pad * 2, H = maxY - minY + pad * 2;
    let S = 2;
    if (Math.max(W, H) * S > 8192) S = Math.max(1, 8192 / Math.max(W, H));

    const cv = document.createElement('canvas');
    cv.width = Math.round(W * S);
    cv.height = Math.round(H * S);
    const ctx = cv.getContext('2d');
    ctx.scale(S, S);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(pad - minX, pad - minY);
    const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

    function rr(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    function rrTop(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
    }

    // 1) 관계선
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#8792a8';
    ctx.lineJoin = 'round';
    for (const { rel, g } of geoms) {
      if (!g) continue;
      ctx.setLineDash(rel.identifying ? [] : [6, 4]);
      ctx.beginPath();
      g.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      ctx.setLineDash([]);
      for (const m of [g.m1, g.m2]) {
        const px = -m.dy, py = m.dx;
        ctx.beginPath();
        if (m.kind === 'one') {
          ctx.moveTo(m.x + m.dx * 11 + px * 6, m.y + m.dy * 11 + py * 6);
          ctx.lineTo(m.x + m.dx * 11 - px * 6, m.y + m.dy * 11 - py * 6);
        } else {
          const qx = m.x + m.dx * 13, qy = m.y + m.dy * 13;
          ctx.moveTo(qx, qy); ctx.lineTo(m.x + px * 7, m.y + py * 7);
          ctx.moveTo(qx, qy); ctx.lineTo(m.x, m.y);
          ctx.moveTo(qx, qy); ctx.lineTo(m.x - px * 7, m.y - py * 7);
        }
        ctx.stroke();
      }
    }

    // 2) 메모
    ctx.textBaseline = 'middle';
    for (const m of d.memos || []) {
      rr(m.x, m.y, m.w, m.h, 4);
      ctx.fillStyle = m.color || '#fff3a8';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,.07)';
      ctx.fillRect(m.x, m.y, m.w, 14);
      ctx.fillStyle = '#3a3a2c';
      ctx.font = '12px ' + FONT;
      const maxW = m.w - 16, lh = 17;
      let ty = m.y + 14 + 6 + lh / 2;
      for (const para of String(m.text || '').split('\n')) {
        let line = '';
        for (const ch of para) {
          if (ctx.measureText(line + ch).width > maxW) {
            ctx.fillText(line, m.x + 8, ty); ty += lh; line = ch;
          } else line += ch;
          if (ty > m.y + m.h - 8) break;
        }
        if (ty > m.y + m.h - 8) break;
        ctx.fillText(line, m.x + 8, ty);
        ty += lh;
      }
    }

    // 3) 테이블
    for (const t of d.tables) {
      const r = rects.get(t.id);
      if (!r) continue;
      rr(r.x, r.y, r.w, r.h, 6);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#c9d2e0';
      ctx.lineWidth = 1;
      ctx.stroke();
      rrTop(r.x, r.y, r.w, GEO.HEAD, 6);
      ctx.fillStyle = t.color || '#3b6fe0';
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.font = '700 13px ' + FONT;
      ctx.textAlign = 'left';
      ctx.fillText(t.name || '', r.x + 10, r.y + GEO.HEAD / 2, r.w - 20);
      if (t.physicalName) {
        ctx.font = '11px ' + FONT;
        ctx.globalAlpha = .85;
        ctx.textAlign = 'right';
        const nameW = ctx.measureText('').width;
        ctx.fillText(t.physicalName, r.x + r.w - 10, r.y + GEO.HEAD / 2,
          Math.max(30, r.w - 30 - ctx.measureText(t.name || '').width - nameW));
        ctx.globalAlpha = 1;
        ctx.textAlign = 'left';
      }

      const lead = ERD.util.leadPk(t.columns);
      let y = r.y + GEO.HEAD + GEO.PAD;
      t.columns.forEach((c, i) => {
        if (i === lead && lead > 0 && lead < t.columns.length) {
          ctx.strokeStyle = '#dfe5ee';
          ctx.beginPath();
          ctx.moveTo(r.x + 1, y + 2.5);
          ctx.lineTo(r.x + r.w - 1, y + 2.5);
          ctx.stroke();
          y += GEO.DIV;
        }
        const cy = y + GEO.ROW / 2;
        // 키 뱃지
        if (c.pk || c.fkRel) {
          ctx.font = '700 8px ' + FONT;
          ctx.fillStyle = c.pk ? '#c9a227' : '#8a94a6';
          ctx.fillText(c.pk ? 'PK' : 'FK', r.x + 8, cy);
        }
        // 이름
        let tx = r.x + 26;
        ctx.font = '12px ' + FONT;
        if (c.label) {
          ctx.fillStyle = '#0f1522';
          ctx.fillText(c.label, tx, cy);
          tx += ctx.measureText(c.label).width + 6;
          ctx.fillStyle = '#8a94a6';
        } else {
          ctx.fillStyle = '#0f1522';
        }
        ctx.fillText(c.name || '', tx, cy);
        // 타입 / NN
        ctx.textAlign = 'right';
        ctx.font = '700 9px ' + FONT;
        ctx.fillStyle = '#a3adc0';
        if (c.nn || c.pk) ctx.fillText('NN', r.x + r.w - 8, cy);
        ctx.font = '11px ' + FONT;
        ctx.fillStyle = '#7c8698';
        ctx.fillText(c.type || '', r.x + r.w - 30, cy);
        ctx.textAlign = 'left';
        y += GEO.ROW;
      });
    }

    const url = cv.toDataURL('image/png');
    ERD.util.download((filename || 'erd') + '.png', url);
    return url;
  }

  ERD.Export = { sql, png };
})();
