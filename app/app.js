(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const cv = $('cv'), ctx = cv.getContext('2d');
  const loupe = $('loupe'), lctx = loupe.getContext('2d');

  // ---- 状態 ----
  const S = {
    img: null,            // HTMLCanvasElement（回転・反転を焼き込んだ原画像）
    lm: {},               // id -> {x,y} | [{x,y}...]
    active: 'head',
    view: { s: 1, tx: 0, ty: 0 },
    filt: { b: 100, c: 100, inv: false },
    caseKey: null,        // 保存済み症例の主キー
    calc: null,
    sourceUrl: '',
    auto: {},             // 自動検出した項目 id -> { conf: 'high'|'low', note }（手で動かすと消える）
    trace: {},            // 自動検出で追った縁（表示用）id -> [{x,y}...]
    armed: null,          // 「自動」を押してタップ待ちの項目 id
    sel: null,            // 右の計測結果で選んだ項目の key（画像上で強調）
  };
  // iPhone・iPad アプリのときだけ使うネイティブ機能（書き出し・写真・貼り付け）
  const Cap = window.Capacitor;
  // @capacitor/core を同梱していないため registerPlugin は無い。ネイティブブリッジの nativePromise で直接呼ぶ
  const callNative = (m, o = {}) => {
    const p = Cap.Plugins && Cap.Plugins.XrayExport;
    return p && typeof p[m] === 'function' ? p[m](o) : Cap.nativePromise('XrayExport', m, o);
  };
  const nativeExport = Cap && Cap.isNativePlatform && Cap.isNativePlatform()
    ? { share: (o) => callNative('share', o), pickPhoto: () => callNative('pickPhoto'), pasteImage: () => callNative('pasteImage') } : null;
  const LM = XG.LANDMARKS;
  const lmDef = (id) => LM.find((l) => l.id === id);

  // ---- IndexedDB ----
  const DB = {
    db: null,
    open() {
      return new Promise((res, rej) => {
        const q = indexedDB.open('shoulder-xray', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('cases', { keyPath: 'key', autoIncrement: true });
        q.onsuccess = () => { this.db = q.result; res(); };
        q.onerror = () => rej(q.error);
      });
    },
    tx(mode) { return this.db.transaction('cases', mode).objectStore('cases'); },
    put(rec) { return new Promise((res, rej) => { const q = this.tx('readwrite').put(rec); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    get(key) { return new Promise((res, rej) => { const q = this.tx('readonly').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    all() { return new Promise((res, rej) => { const q = this.tx('readonly').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    del(key) { return new Promise((res, rej) => { const q = this.tx('readwrite').delete(key); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); },
    // 削除した症例は「削除済み」の印（tombstone）として残し、iCloud でほかの端末にも削除を伝える
    async live() { return (await this.all()).filter((r) => !r.deleted); },
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  }));

  // 未保存の変更があるか（保存・読込時点の点と比べる）
  const isDirty = () => Object.keys(S.lm).length > 0 && JSON.stringify(S.lm) !== S.savedLm;

  // ブラウザ標準の confirm() は環境によって無効化されるため、アプリ内のダイアログで聞く
  function ask(msg, okLabel = 'OK', danger = false) {
    const d = $('dlgAsk');
    $('askMsg').textContent = msg;
    $('askOk').textContent = okLabel;
    $('askOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    d.showModal();
    return new Promise((res) => {
      const done = (v) => { d.close(); $('askOk').onclick = $('askCancel').onclick = null; d.oncancel = null; res(v); };
      $('askOk').onclick = () => done(true);
      $('askCancel').onclick = () => done(false);
      d.oncancel = (e) => { e.preventDefault(); done(false); };
    });
  }

  function toast(msg, ms = 2200) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---- 画像取り込み ----
  // iOS の canvas は面積の上限（約1677万画素）を超えると真っ白・失敗になるため、大きな写真は縮小して取り込む
  const MAX_SIDE = 4096, MAX_AREA = 16e6;
  async function decodeImage(blob) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(blob); } catch (e) { /* 下の Image で再試行 */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  async function loadBlob(blob, srcUrl = '') {
    if (!blob || (blob.type && !blob.type.startsWith('image/'))) { toast('画像ファイルではありません'); return; }
    let im;
    try { im = await decodeImage(blob); } catch (e) {
      toast(/heic|heif/i.test(blob.type) ? 'HEIC を開けませんでした。「写真」ボタンから選ぶか、スクリーンショットで取り込んでください' : '画像を開けませんでした（DICOM は未対応。PNG/JPEG に書き出してください）', 5000);
      return;
    }
    const w0 = im.naturalWidth || im.width, h0 = im.naturalHeight || im.height;
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0), Math.sqrt(MAX_AREA / (w0 * h0)));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    const g = c.getContext('2d');
    if (!g) { toast('画像が大きすぎて開けませんでした', 4000); return; }
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, 0, 0, c.width, c.height);
    if (im.close) im.close();
    if (S.img && isDirty() && !await ask('保存していないプロットがあります。破棄して新しい画像を読み込みますか？', '読み込む')) return;
    resetCase();
    S.img = c; S.sourceUrl = srcUrl;
    setSections(true);
    checkImplant();
    fitView(); refresh();
    toast(`読み込み ${c.width}×${c.height}px${k < 1 ? `（元 ${w0}×${h0} を縮小）` : ''}`);
  }
  // ネイティブ（iPhone・iPad）：写真ライブラリとクリップボードはアプリ側で読む
  const b64ToBlob = (b64, type) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
  async function nativeImage(method) {
    try {
      const r = await nativeExport[method]();
      if (r && r.data) loadBlob(b64ToBlob(r.data, 'image/jpeg'));
    } catch (e) {
      const m = (e && e.message) || String(e);
      if (!/cancel/i.test(m)) toast(m, 3500);
    }
  }

  if (nativeExport) { $('btnPhotos').hidden = false; $('btnPhotos').onclick = () => nativeImage('pickPhoto'); $('btnPasteHelp').textContent = '貼り付け（コピーした画像）'; }
  // ヘッダーのドロップダウン（取り込み・調整・その他）。調整は開いたまま操作できるよう、外側タップでだけ閉じる
  const closeMenus = (except) => document.querySelectorAll('.ddmenu').forEach((m) => { if (m !== except) m.hidden = true; });
  document.querySelectorAll('.dd').forEach((dd) => {
    const menu = dd.querySelector('.ddmenu');
    dd.querySelector('.ddbtn').onclick = (e) => { e.stopPropagation(); closeMenus(menu); menu.hidden = !menu.hidden; };
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!('keep' in menu.dataset) && e.target.closest('.btn')) setTimeout(() => { menu.hidden = true; }, 0);
    });
  });
  document.addEventListener('click', () => closeMenus());
  $('fileInput').onchange = (e) => { if (e.target.files[0]) loadBlob(e.target.files[0]); e.target.value = ''; };
  $('camInput').onchange = (e) => { if (e.target.files[0]) loadBlob(e.target.files[0]); e.target.value = ''; };
  $('btnPasteHelp').onclick = async () => {
    if (nativeExport) return nativeImage('pasteImage');
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const t = it.types.find((x) => x.startsWith('image/'));
        if (t) { loadBlob(await it.getType(t)); return; }
      }
      toast('クリップボードに画像がありません');
    } catch { toast('⌘V で貼り付けてください（スクリーンショットは ⌘⇧⌃4 でクリップボードへ）', 3500); }
  };
  document.addEventListener('paste', (e) => {
    if (e.target.matches?.('input, textarea')) return;
    const f = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (f) { e.preventDefault(); loadBlob(f.getAsFile()); }
  });
  const stage = document.querySelector('.stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', async (e) => {
    e.preventDefault(); stage.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) return loadBlob(f);
    const u = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (u) fetchUrl(u.trim());
  });
  async function fetchUrl(u) {
    try {
      const r = await fetch(u, { mode: 'cors' });
      if (!r.ok) throw new Error(r.status);
      loadBlob(await r.blob(), u);
    } catch {
      toast('このサイトからは直接取得できません。画像を右クリック→コピー→⌘V で貼り付けてください', 4500);
    }
  }
  $('btnUrl').onclick = () => $('dlgUrl').showModal();
  $('btnUrlCancel').onclick = () => $('dlgUrl').close();
  $('btnUrlGo').onclick = () => { const u = $('urlInput').value.trim(); $('dlgUrl').close(); if (u) fetchUrl(u); };

  // 回転・反転は画像とプロット済みの点を一緒に変換する
  function transformImage(kind) {
    if (!S.img) return;
    const w = S.img.width, h = S.img.height;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    let map;
    if (kind === 'flip') { c.width = w; c.height = h; g.translate(w, 0); g.scale(-1, 1); map = (p) => ({ x: w - p.x, y: p.y }); }
    else if (kind === 'R') { c.width = h; c.height = w; g.translate(h, 0); g.rotate(Math.PI / 2); map = (p) => ({ x: h - p.y, y: p.x }); }
    else { c.width = h; c.height = w; g.translate(0, w); g.rotate(-Math.PI / 2); map = (p) => ({ x: p.y, y: w - p.x }); }
    g.drawImage(S.img, 0, 0);
    S.img = c;
    for (const k in S.lm) S.lm[k] = Array.isArray(S.lm[k]) ? S.lm[k].map(map) : map(S.lm[k]);
    for (const k in S.trace) S.trace[k] = S.trace[k].map(map);
    fitView(); refresh();
  }
  $('btnRotL').onclick = () => transformImage('L');
  $('btnRotR').onclick = () => transformImage('R');
  $('btnFlip').onclick = () => transformImage('flip');
  $('bright').oninput = (e) => { S.filt.b = +e.target.value; draw(); };
  $('contrast').oninput = (e) => { S.filt.c = +e.target.value; draw(); };
  $('btnInvert').onclick = () => { S.filt.inv = !S.filt.inv; draw(); };
  $('btnFit').onclick = () => { fitView(); draw(); };

  // ---- ビュー ----
  function resize() {
    const r = stage.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
    draw();
  }
  function fitView() {
    if (!S.img) return;
    const W = cv.width, H = cv.height;
    const s = Math.min(W / S.img.width, H / S.img.height) * 0.95;
    S.view = { s, tx: (W - S.img.width * s) / 2, ty: (H - S.img.height * s) / 2 };
  }
  const dpr = () => devicePixelRatio || 1;
  const toImg = (sx, sy) => ({ x: (sx * dpr() - S.view.tx) / S.view.s, y: (sy * dpr() - S.view.ty) / S.view.s });
  const toScr = (p) => ({ x: p.x * S.view.s + S.view.tx, y: p.y * S.view.s + S.view.ty }); // canvas px

  // ---- 描画 ----
  const COL = { base: '#3fd0ff', glen: '#ffd23f', acr: '#ff8a3f', hum: '#7dff8a', imp: '#ff5fd2', scap: '#c9a0ff', cal: '#ffffff', axis: '#3fd0ff', alt: '#ffd23f' };
  const groupCol = { '基準軸': COL.base, '関節窩': COL.glen, '肩峰': COL.acr, '上腕骨頭': '#c4ff6b', '上腕骨': COL.hum, 'インプラント': COL.imp, '肩甲骨': COL.scap, '較正': COL.cal };

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    $('emptyMsg').style.display = S.img ? 'none' : '';
    if (!S.img) return;
    ctx.setTransform(S.view.s, 0, 0, S.view.s, S.view.tx, S.view.ty);
    ctx.filter = `brightness(${S.filt.b}%) contrast(${S.filt.c}%)${S.filt.inv ? ' invert(1)' : ''}`;
    ctx.drawImage(S.img, 0, 0);
    ctx.filter = 'none';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawOverlay(ctx, toScr, dpr());
  }

  function line(g, a, b, col, w, dash) {
    g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []);
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.setLineDash([]);
  }
  // 直線 a-b を画面いっぱいに延長
  function longLine(g, T, a, b, col, w, dash) {
    const d = { x: b.x - a.x, y: b.y - a.y }, L = Math.hypot(d.x, d.y) || 1, k = 4000 / L;
    line(g, T({ x: a.x - d.x * k, y: a.y - d.y * k }), T({ x: a.x + d.x * k, y: a.y + d.y * k }), col, w, dash);
  }

  // ピラーを置く区間の目安：SFL から下へ start〜start+len mm（較正済みのときだけ）
  function drawPillarBand(g, T, z) {
    const a = S.lm.sfl_m, b = S.lm.sfl_l, mmpx = S.calc && S.calc.mmpx;
    if (!a || !b || !mmpx || Array.isArray(a)) return;
    const st = parseFloat($('bandStart').value), ln = parseFloat($('bandLen').value);
    if (!(st >= 0 && ln > 0)) return;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let ey = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
    if (ey.y > 0) ey = { x: -ey.x, y: -ey.y };
    for (const mm of [st, st + ln]) {
      const k = -mm / mmpx;
      longLine(g, T, { x: a.x + ey.x * k, y: a.y + ey.y * k }, { x: b.x + ey.x * k, y: b.y + ey.y * k }, '#3fd0ff55', 1 * z, [2 * z, 6 * z]);
    }
  }

  // 回転中心を原点にした軸：肩甲骨側（X＝SFL・外側 −、Y＝垂線・上方 +）と上腕骨側（Y＝骨軸・下方 +、X＝垂線・外側 +）
  function drawCorAxes(g, T, z) {
    const calc = S.calc; if (!calc) return;
    const L = calc.mmpx ? 50 / calc.mmpx : 250 / S.view.s * z; // 片側 50mm（未較正は画面上の長さ）
    const axis = (c, d, col, plus, minus) => {
      const a = T({ x: c.x - d.x * L, y: c.y - d.y * L }), b = T({ x: c.x + d.x * L, y: c.y + d.y * L });
      g.strokeStyle = '#000a'; g.lineWidth = 4 * z; g.setLineDash([]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      line(g, a, b, col, 2 * z);
      // + 側に矢じり
      const ang = Math.atan2(b.y - a.y, b.x - a.x), h = 9 * z;
      g.fillStyle = col; g.beginPath(); g.moveTo(b.x, b.y);
      g.lineTo(b.x - h * Math.cos(ang - 0.4), b.y - h * Math.sin(ang - 0.4));
      g.lineTo(b.x - h * Math.cos(ang + 0.4), b.y - h * Math.sin(ang + 0.4)); g.fill();
      if ($('optLabels').checked) {
        g.font = `bold ${11 * z}px system-ui`; g.lineWidth = 3 * z; g.strokeStyle = '#000c';
        for (const [t, q] of [[plus, b], [minus, a]]) { g.strokeText(t, q.x + 6 * z, q.y - 4 * z); g.fillText(t, q.x + 6 * z, q.y - 4 * z); }
      }
    };
    for (const [key, col] of [['head', COL.hum], ['sphere', COL.imp]]) {
      const ce = calc[key]; if (!ce) continue;
      const c = ce.c;
      if (calc.ex) {
        axis(c, { x: -calc.ex.x, y: -calc.ex.y }, COL.base, '肩甲骨 X+（内側）', '外側 −');
        axis(c, calc.ey, COL.base, '肩甲骨 Y+（上方）', '');
      }
      if (calc.shaft) {
        axis(c, calc.shaft.nl, COL.hum, '上腕骨 X+（外側）', '');
        axis(c, calc.shaft.dd, COL.hum, '上腕骨 Y+（下方）', '');
      }
      // 軸だけ表示：肩峰外側端→肩甲骨の軸、大結節最外側点→上腕骨の軸へ垂線（足が座標値）
      if ($('optCorOnly').checked) {
        const perpTo = (p, d, col) => {
          const t = (p.x - c.x) * d.x + (p.y - c.y) * d.y;
          const a = T(p), f = T({ x: c.x + d.x * t, y: c.y + d.y * t });
          line(g, a, f, col + 'dd', 1.5 * z, [4 * z, 3 * z]);
          g.fillStyle = col; g.fillRect(f.x - 3 * z, f.y - 3 * z, 6 * z, 6 * z);
        };
        const acr = S.lm.acr_l, gt = S.lm.gt_l;
        if (acr && !Array.isArray(acr) && calc.ex) { perpTo(acr, calc.ex, COL.base); perpTo(acr, calc.ey, COL.base); }
        if (gt && !Array.isArray(gt) && calc.shaft) { perpTo(gt, calc.shaft.nl, COL.hum); perpTo(gt, calc.shaft.dd, COL.hum); }
      }
      const cc = T(c);
      g.fillStyle = '#000'; g.beginPath(); g.arc(cc.x, cc.y, 6 * z, 0, 7); g.fill();
      g.fillStyle = col; g.beginPath(); g.arc(cc.x, cc.y, 4 * z, 0, 7); g.fill();
      if ($('optLabels').checked) {
        const t = key === 'head' ? '回転中心（骨頭中心）' : '回転中心（glenosphere）';
        g.font = `${11 * z}px system-ui`; g.lineWidth = 3 * z; g.strokeStyle = '#000c';
        g.strokeText(t, cc.x + 8 * z, cc.y + 16 * z); g.fillText(t, cc.x + 8 * z, cc.y + 16 * z);
      }
    }
  }

  function drawOverlay(g, T, z) {
    const lm = S.lm, calc = S.calc;
    const P = (id) => (lm[id] && !Array.isArray(lm[id])) ? lm[id] : null;
    // 「軸だけ表示」：回転中心と軸のほかは描かない
    if ($('optCorOnly').checked) {
      // 上腕骨の骨軸（外方化はこの線までの距離）
      if (calc && calc.shaft) {
        const sc = calc.shaft.c, sd = calc.shaft.d;
        longLine(g, T, sc, { x: sc.x + sd.x, y: sc.y + sd.y }, COL.hum + 'cc', 1.5 * z, [8 * z, 4 * z]);
        calc.shaft.mids.forEach((m) => { const q = T(m); g.fillStyle = COL.hum; g.fillRect(q.x - 3 * z, q.y - 3 * z, 6 * z, 6 * z); });
        if ($('optLabels').checked) {
          const q = T(calc.shaft.mids[calc.shaft.mids.length - 1] || sc);
          g.font = `${11 * z}px system-ui`; g.fillStyle = COL.hum;
          g.lineWidth = 3 * z; g.strokeStyle = '#000c';
          g.strokeText('上腕骨 骨軸', q.x + 8 * z, q.y); g.fillText('上腕骨 骨軸', q.x + 8 * z, q.y);
        }
      }
      drawCorAxes(g, T, z);
      // 外方化・下方化を読む点（肩峰外側端・大結節）は残す
      g.font = `${11 * z}px system-ui`;
      for (const d of LM) {
        if (!['acr_l', 'gt_s', 'gt_l'].includes(d.id) || !P(d.id)) continue;
        const s = T(P(d.id));
        g.strokeStyle = '#000'; g.lineWidth = 3 * z;
        g.beginPath(); g.arc(s.x, s.y, 5 * z, 0, 7); g.stroke();
        g.fillStyle = groupCol[d.group]; g.fill();
        if ($('optLabels').checked) { g.lineWidth = 3 * z; g.strokeStyle = '#000c'; g.strokeText(d.label, s.x + 8 * z, s.y - 6 * z); g.fillText(d.label, s.x + 8 * z, s.y - 6 * z); }
      }
      if (S.mode === 'keystone') drawKeystone(g, T, z);
      return;
    }
    if (calc) {
      if ($('optAxes').checked) {
        if (P('sfl_m') && P('sfl_l')) longLine(g, T, P('sfl_m'), P('sfl_l'), COL.base + 'aa', 1.2 * z, [6 * z, 4 * z]);
        if (calc.pillar) longLine(g, T, calc.pillar.p1, calc.pillar.p2, COL.base + '99', 1.2 * z, [3 * z, 4 * z]);
        drawPillarBand(g, T, z);
        const drawFrame = (f, col, name) => {
          const o = T(f.o), L = 80 * z;
          const ax = T(f.toImage({ x: 80 / S.view.s * z, y: 0 })), ay = T(f.toImage({ x: 0, y: 80 / S.view.s * z }));
          line(g, o, ax, col, 2.5 * z); line(g, o, ay, col, 2.5 * z);
          g.fillStyle = col; g.font = `${12 * z}px system-ui`;
          g.fillText('X', ax.x + 4 * z, ax.y); g.fillText('Y', ay.x + 4 * z, ay.y);
          g.beginPath(); g.arc(o.x, o.y, 5 * z, 0, 7); g.fill();
          if ($('optLabels').checked) g.fillText(name, o.x + 8 * z, o.y + 16 * z);
        };
        if (calc.frame) drawFrame(calc.frame, COL.axis, 'O (SFL×pillar)');
        if (calc.altFrame && $('optAltFrame').checked) {
          if (P('gl_s') && P('gl_i')) longLine(g, T, P('gl_s'), P('gl_i'), COL.alt + '66', 1 * z, [3 * z, 4 * z]);
          drawFrame(calc.altFrame, COL.alt, "O' (SFL×glenoid)");
        }
      }
      if ($('optAngles').checked) {
        const seg = (a, b, c) => { if (P(a) && P(b)) line(g, T(P(a)), T(P(b)), c, 1.2 * z); };
        seg('gl_i', 'gl_s', COL.glen); seg('gl_i', 'acr_l', COL.acr + 'cc');
        seg('gl_s', 'acr_l', COL.acr + '88'); seg('gl_s', 'gt_l', COL.hum + 'aa'); seg('acr_l', 'gt_l', COL.hum + '77');
        seg('gl_s', 'scap_inf', COL.scap + 'aa'); seg('gl_i', 'gl_il', COL.glen + 'ff');
      }
      for (const [key, col] of [['head', COL.hum], ['sphere', COL.imp]]) {
        const c = calc[key]; if (!c) continue;
        const cc = T(c.c);
        g.strokeStyle = col; g.lineWidth = 1.5 * z;
        g.beginPath(); g.arc(cc.x, cc.y, c.r * S.view.s, 0, 7); g.stroke();
        line(g, { x: cc.x - 8 * z, y: cc.y }, { x: cc.x + 8 * z, y: cc.y }, col, 2 * z);
        line(g, { x: cc.x, y: cc.y - 8 * z }, { x: cc.x, y: cc.y + 8 * z }, col, 2 * z);
      }
      if ($('optAxes').checked) {
        if (calc.shaft) {
          const sh = lm.shaft;
          for (let i = 0; i + 1 < sh.length; i += 2) line(g, T(sh[i]), T(sh[i + 1]), COL.hum + '66', 1 * z);
          longLine(g, T, calc.shaft.c, { x: calc.shaft.c.x + calc.shaft.d.x, y: calc.shaft.c.y + calc.shaft.d.y }, COL.hum + 'aa', 1.2 * z, [8 * z, 4 * z]);
          calc.shaft.mids.forEach((m) => { const q = T(m); g.fillStyle = COL.hum; g.fillRect(q.x - 3 * z, q.y - 3 * z, 6 * z, 6 * z); });
        }
        if (calc.headAxis) {
          const { p, h } = calc.headAxis;
          if (P('neck_s') && P('neck_i')) line(g, T(P('neck_s')), T(P('neck_i')), '#c4ff6b', 1.2 * z);
          longLine(g, T, p, { x: p.x + h.x, y: p.y + h.y }, '#c4ff6b88', 1.2 * z, [2 * z, 4 * z]);
        }
        if (calc.acrPts && calc.acrPts.length > 1) {
          g.strokeStyle = COL.acr; g.lineWidth = 1.5 * z; g.beginPath();
          calc.acrPts.forEach((q, i) => { const t = T(q); i ? g.lineTo(t.x, t.y) : g.moveTo(t.x, t.y); }); g.stroke();
        }
        if (calc.refGl) {
          longLine(g, T, calc.refGl.i, calc.refGl.s, '#ffffffaa', 1.2 * z, [10 * z, 5 * z]);
          line(g, T(calc.refGl.i), T(calc.refGl.s), '#ffffff', 2.5 * z);
          const t = T(calc.refGl.s); g.fillStyle = '#fff'; g.font = `${11 * z}px system-ui`;
          if ($('optLabels').checked) g.fillText('本来の関節窩（基準）', t.x + 8 * z, t.y);
        }
        if (calc.refHead) {
          const t = T(calc.refHead); g.strokeStyle = '#fff'; g.lineWidth = 1.5 * z;
          g.beginPath(); g.arc(t.x, t.y, 6 * z, 0, 7); g.stroke();
          line(g, { x: t.x - 10 * z, y: t.y - 10 * z }, { x: t.x + 10 * z, y: t.y + 10 * z }, '#fff', 1.2 * z);
          line(g, { x: t.x - 10 * z, y: t.y + 10 * z }, { x: t.x + 10 * z, y: t.y - 10 * z }, '#fff', 1.2 * z);
        }
      }
    }
    if ($('optCor').checked) drawCorAxes(g, T, z);
    if (S.mode === 'keystone') drawKeystone(g, T, z);
    drawHighlight(g, T, z);
    // 自動検出で追った縁（薄い点）
    for (const tr of Object.values(S.trace)) {
      g.fillStyle = '#ffffff66';
      tr.forEach((q) => { const t = T(q); g.fillRect(t.x - 1.5 * z, t.y - 1.5 * z, 3 * z, 3 * z); });
    }
    // 点
    g.font = `${11 * z}px system-ui`;
    for (const d of LM) {
      const v = lm[d.id]; if (!v) continue;
      const col = groupCol[d.group];
      const pts = Array.isArray(v) ? v : [v];
      pts.forEach((p, i) => {
        const s = T(p), act = d.id === S.active;
        g.strokeStyle = '#000'; g.lineWidth = 3 * z;
        g.beginPath(); g.arc(s.x, s.y, (act ? 6 : 4.5) * z, 0, 7); g.stroke();
        g.fillStyle = col; g.fill();
        const au = S.auto[d.id] || ((d.id === 'sfl_m' || d.id === 'sfl_l') && S.auto.sfl);
        if (au) { // 自動配置：確からしさが低いものは橙の破線の輪
          g.strokeStyle = au.conf === 'high' ? '#ffffffaa' : '#ff9f1c'; g.lineWidth = 1.5 * z;
          g.setLineDash(au.conf === 'high' ? [] : [3 * z, 2 * z]);
          g.beginPath(); g.arc(s.x, s.y, (act ? 10 : 8) * z, 0, 7); g.stroke(); g.setLineDash([]);
        }
        if ($('optLabels').checked && (i === 0 || act)) {
          const num = d.kind === 'pairs' ? `${Math.floor(i / 2) + 1}${i % 2 ? '内' : '外'}` : i + 1;
          const t = Array.isArray(v) ? `${d.label.replace(/（.*/, '')}${act ? ' ' + num : ''}` : d.label;
          g.lineWidth = 3 * z; g.strokeStyle = '#000c'; g.strokeText(t, s.x + 8 * z, s.y - 6 * z);
          g.fillText(t, s.x + 8 * z, s.y - 6 * z);
        }
      });
    }
  }

  // 右の計測結果で選んだ項目を、画像上で黒縁つきの黄色で強調する
  function drawHighlight(g, T, z) {
    const r = S.sel && S.calc && S.calc.results.find((x) => x.key === S.sel);
    if (!r || !r.hl) return;
    const h = r.hl, col = '#ffeb3b';
    const stroke = (fn, w, dash) => {
      for (const [c, k] of [['#000c', 3], [col, 1]]) { g.strokeStyle = c; g.lineWidth = (w + k) * z; g.setLineDash(dash || []); g.beginPath(); fn(); g.stroke(); }
      g.setLineDash([]);
    };
    const ok = (p) => p && Number.isFinite(p.x);
    (h.lines || []).forEach(([a, b]) => { if (ok(a) && ok(b)) longLine(g, T, a, b, col + 'aa', 1.5 * z, [8 * z, 5 * z]); });
    (h.circles || []).forEach((c) => { const cc = T(c.c); stroke(() => g.arc(cc.x, cc.y, c.r * S.view.s, 0, 7), 2.5); });
    if (h.poly) stroke(() => h.poly.forEach((q, i) => { const t = T(q); i ? g.lineTo(t.x, t.y) : g.moveTo(t.x, t.y); }), 2.5);
    (h.segs || []).forEach(([a, b]) => { if (ok(a) && ok(b)) { const A = T(a), B = T(b); stroke(() => { g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); }, 3.5); } });
    if (h.ang && h.ang.every(ok)) {
      const [v, a, b] = h.ang.map(T);
      stroke(() => { g.moveTo(a.x, a.y); g.lineTo(v.x, v.y); g.lineTo(b.x, b.y); }, 3);
      const a1 = Math.atan2(a.y - v.y, a.x - v.x), a2 = Math.atan2(b.y - v.y, b.x - v.x);
      let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      stroke(() => g.arc(v.x, v.y, 36 * z, a1, a1 + d, d < 0), 2.5);
    }
    (h.pts || []).forEach((p) => { if (!ok(p)) return; const t = T(p); g.fillStyle = col; g.strokeStyle = '#000'; g.lineWidth = 2 * z; g.beginPath(); g.arc(t.x, t.y, 5 * z, 0, 7); g.fill(); g.stroke(); });
    // 値のラベル
    const anchor = (h.segs && h.segs[0] && h.segs[0][1]) || (h.ang && h.ang[0]) || (h.circles && h.circles[0].c) || (h.pts && h.pts[0]);
    if (ok(anchor)) {
      const t = T(anchor), txt = `${r.label.replace(/（.*/, '')} ${fmt(r.value, r.unit)}${r.unit}`;
      g.font = `bold ${13 * z}px system-ui`; g.lineWidth = 4 * z; g.strokeStyle = '#000'; g.strokeText(txt, t.x + 10 * z, t.y - 10 * z);
      g.fillStyle = col; g.fillText(txt, t.x + 10 * z, t.y - 10 * z);
    }
  }

  // ---- ルーペ（指で隠れる位置を拡大表示） ----
  function showLoupe(p, sx, sy) {
    if (!S.img) return;
    const k = 4, R = loupe.width / 2;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.fillStyle = '#000'; lctx.fillRect(0, 0, loupe.width, loupe.height);
    const sc = S.view.s * k / dpr();
    lctx.setTransform(sc, 0, 0, sc, R - p.x * sc, R - p.y * sc);
    lctx.filter = `brightness(${S.filt.b}%) contrast(${S.filt.c}%)${S.filt.inv ? ' invert(1)' : ''}`;
    lctx.drawImage(S.img, 0, 0); lctx.filter = 'none';
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    drawOverlay(lctx, (q) => ({ x: R + (q.x - p.x) * sc, y: R + (q.y - p.y) * sc }), 1);
    lctx.strokeStyle = '#ff0'; lctx.lineWidth = 1;
    lctx.beginPath(); lctx.moveTo(R - 12, R); lctx.lineTo(R + 12, R); lctx.moveTo(R, R - 12); lctx.lineTo(R, R + 12); lctx.stroke();
    const W = stage.clientWidth;
    loupe.style.left = (sx < W / 2 ? W - loupe.width - 12 : 12) + 'px';
    loupe.style.top = '12px';
    loupe.style.display = 'block';
  }
  const hideLoupe = () => { loupe.style.display = 'none'; };

  // ---- ポインタ操作 ----
  // タップ: アクティブ項目に点を置く / 既存点ドラッグ: 移動 / 空所ドラッグ: パン / 2本指・ホイール: ズーム
  const ptrs = new Map();
  let drag = null; // { type: 'pt'|'pan'|'pinch', ... }
  function hitPoint(sx, sy) {
    const z = dpr(), R = 14 * z, s = { x: sx * z, y: sy * z };
    let best = null;
    for (const d of LM) {
      const v = S.lm[d.id]; if (!v) continue;
      (Array.isArray(v) ? v : [v]).forEach((p, i) => {
        const q = toScr(p), dd = Math.hypot(q.x - s.x, q.y - s.y);
        if (dd < R && (!best || dd < best.d)) best = { id: d.id, i: Array.isArray(v) ? i : -1, d: dd };
      });
    }
    return best;
  }
  const rel = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  cv.addEventListener('pointerdown', (e) => {
    if (!S.img) return;
    cv.setPointerCapture(e.pointerId);
    const p = rel(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...S.view } };
      hideLoupe(); return;
    }
    if (S.mode === 'keystone') {
      const k = hitKeystone(p.x, p.y);
      drag = k >= 0 ? { type: 'kq', i: k } : { type: 'pan', start: p, v0: { ...S.view }, moved: false };
      return;
    }
    const h = hitPoint(p.x, p.y);
    if (h) { drag = { type: 'pt', ...h, moved: false }; S.active = h.id; renderList(); showLoupe(toImg(p.x, p.y), p.x, p.y); }
    else drag = { type: 'pan', start: p, v0: { ...S.view }, moved: false };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const p = rel(e); ptrs.set(e.pointerId, p);
    if (!drag) return;
    if (drag.type === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      zoomAt(drag.m0, d / drag.d0, drag.v0); S.view.tx += (m.x - drag.m0.x) * dpr(); S.view.ty += (m.y - drag.m0.y) * dpr();
      draw();
    } else if (drag.type === 'kq') {
      const ip = toImg(p.x, p.y); S.kq[drag.i] = ip; draw(); showLoupe(ip, p.x, p.y);
    } else if (drag.type === 'pt') {
      drag.moved = true;
      const ip = toImg(p.x, p.y);
      if (drag.i < 0) S.lm[drag.id] = ip; else S.lm[drag.id][drag.i] = ip;
      forgetAuto(drag.id);
      recalc(); draw(); showLoupe(ip, p.x, p.y);
    } else if (drag.type === 'pan') {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) { S.view.tx = drag.v0.tx + dx * dpr(); S.view.ty = drag.v0.ty + dy * dpr(); draw(); }
    }
  });
  const endPtr = (e) => {
    const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
    if (!drag) return;
    if (drag.type === 'pan' && !drag.moved && p) {
      if (S.mode === 'keystone') {
        if (S.kq.length < 4) {
          // 近くに縁の交点があれば吸着（半自動）。画面上でおよそ 28px 以内
          const ip = toImg(p.x, p.y), sp = window.XA && XA.snapCorner(S.img, ip, 28 * dpr() / S.view.s);
          S.kq.push(sp || ip); updateKeystoneBar(); draw();
        }
      }
      else placePoint(toImg(p.x, p.y));
    }
    if (drag.type === 'kq') hideLoupe();
    if (drag.type === 'pt') { hideLoupe(); refresh(); }
    if (drag.type !== 'pinch' || ptrs.size === 0) drag = null;
  };
  cv.addEventListener('pointerup', endPtr);
  cv.addEventListener('pointercancel', endPtr);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault(); if (!S.img) return;
    const p = rel(e);
    zoomAt(p, Math.exp(-e.deltaY * 0.0015), { ...S.view }); draw();
  }, { passive: false });
  function zoomAt(sp, k, v0) {
    const z = dpr(), x = sp.x * z, y = sp.y * z;
    const s = Math.max(0.05, Math.min(40, v0.s * k)), kk = s / v0.s;
    S.view = { s, tx: x - (x - v0.tx) * kk, ty: y - (y - v0.ty) * kk };
  }

  function placePoint(p) {
    if (p.x < 0 || p.y < 0 || p.x > S.img.width || p.y > S.img.height) return;
    const d = lmDef(S.active);
    if (S.armed === d.id) { S.armed = null; if (autoPlace(d, p)) return; }
    if (d.kind !== 'pt') {
      (S.lm[d.id] = S.lm[d.id] || []).push(p);
      if (d.id === 'sphere' && $('mCategory').value !== 'RSA') { $('mCategory').value = 'RSA'; S.autoCat = null; }
    } else {
      S.lm[d.id] = p;
      forgetAuto(d.id);
      advance();
    }
    refresh();
  }

  // ---- 半自動検出（autodetect.js）----
  const confText = (c) => c === 'high' ? '確からしさ 高' : '確からしさ 低・要確認';
  function forgetAuto(id) {
    delete S.auto[id]; delete S.trace[id];
    if (id === 'sfl_m' || id === 'sfl_l') { delete S.auto.sfl; delete S.trace.sfl; }
  }
  // 円・ピラー線は、項目が空のときの最初のタップで自動検出。失敗したら普通に1点置く
  function autoPlace(d, p) {
    let r = null;
    if (d.id === 'head' || d.id === 'sphere') {
      const mmpx = S.calc && S.calc.mmpx, sphereCal = $('calMode').value === 'sphere';
      const range = d.id === 'head' ? [15, 34] : [14, 24];
      const o = mmpx && !sphereCal ? { rMin: range[0] / mmpx, rMax: range[1] / mmpx } : {};
      r = XA.detectCircle(S.img, p, o);
      if (r) { S.lm[d.id] = r.pts; S.auto[d.id] = { conf: r.conf }; if (d.id === 'sphere' && $('mCategory').value !== 'RSA') { $('mCategory').value = 'RSA'; S.autoCat = null; } }
    } else if (d.id === 'pillar') {
      const a = P1('sfl_m'), b = P1('sfl_l'), o = {};
      if (a && b) o.lateral = { x: b.x - a.x, y: b.y - a.y };
      const mmpx = S.calc && S.calc.mmpx, st = parseFloat($('bandStart').value), ln = parseFloat($('bandLen').value);
      if (a && b && mmpx && st >= 0 && ln > 0) {
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        let ey = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
        if (ey.y > 0) ey = { x: -ey.x, y: -ey.y };
        o.inBand = (q) => { const mm = -((q.x - a.x) * ey.x + (q.y - a.y) * ey.y) * mmpx; return mm >= st && mm <= st + ln; };
        o.maxLen = (st + ln) / mmpx;
      }
      r = XA.tracePillar(S.img, p, o);
      if (r) { S.lm.pillar = r.pts; S.auto.pillar = { conf: r.conf, note: r.note }; S.trace.pillar = r.trace; }
    } else if (d.id === 'shaft') {
      // 骨頭（なければ sphere）の中心→タップを骨軸のおおよその向きにする
      const ce = (S.calc && (S.calc.head || S.calc.sphere)) || null, mmpx = S.calc && S.calc.mmpx, o = {};
      if (ce) { o.dir = { x: p.x - ce.c.x, y: p.y - ce.c.y }; o.avoid = { c: ce.c, r: ce.r }; }
      o.implant = !!(S.calc && S.calc.sphere) || ['RSA', 'TSA'].includes($('mCategory').value);
      if (mmpx && $('calMode').value !== 'sphere') o.halfMax = 22 / mmpx;
      else if (ce) o.halfMax = ce.r * 1.1;
      r = XA.detectShaft(S.img, p, o);
      if (r) { S.lm.shaft = r.pts; S.auto.shaft = { conf: r.conf, note: r.note }; S.trace.shaft = r.trace; }
    } else return false;
    if (!r) {
      if (S.lm[d.id]) { toast('自動で見つけられませんでした。いまの点はそのままです', 3500); refresh(); return true; }
      toast('自動で見つけられませんでした。手動で点を置いてください（このタップは1点目として置きました）', 3500); return false;
    }
    toast(`${d.label.replace(/（.*/, '')}を自動で置きました（${confText(r.conf)}）。ずれた点はドラッグで直せます${r.note ? '。' + r.note : ''}`, 3500);
    refresh();
    return true;
  }
  const P1 = (id) => (S.lm[id] && !Array.isArray(S.lm[id])) ? S.lm[id] : null;
  // SFL：2点そろったら、間の棘上窩底の線に合わせて2点を寄せる
  function autoSFL() {
    const a = P1('sfl_m'), b = P1('sfl_l');
    if (!a || !b) { toast('SFL の内側点と外側点を置いてから押してください', 3000); return; }
    const r = XA.refineSFL(S.img, a, b);
    if (!r) { toast('SFL の線を自動で見つけられませんでした。タップした位置のままです', 3000); return; }
    S.lm.sfl_m = r.a; S.lm.sfl_l = r.b; S.auto.sfl = { conf: r.conf }; S.trace.sfl = r.trace;
    toast(`SFL を棘上窩底の線に合わせました（${confText(r.conf)}）`, 3000);
    refresh();
  }
  // 項目の「自動」ボタン：点があればそれを手がかりにやり直し、なければ次のタップを待つ
  const AUTO = { sfl_l: 'SFL を線に合わせる', head: '中心付近をタップ', sphere: '中心付近をタップ', pillar: '外側縁の上をタップ', shaft: '骨幹の中ほどをタップ' };
  function runAuto(id) {
    if (!S.img) return;
    S.active = id;
    if (id === 'sfl_l') { S.armed = null; autoSFL(); return; }
    const v = S.lm[id];
    if (Array.isArray(v) && v.length >= (id === 'pillar' ? 2 : 3)) {
      let seed;
      if (id === 'shaft') { if (v.length < 4) { S.armed = S.armed === id ? null : id; refresh(); return; } seed = v.reduce((s, q) => ({ x: s.x + q.x / v.length, y: s.y + q.y / v.length }), { x: 0, y: 0 }); }
      else if (id === 'pillar') { const c = v.reduce((s, q) => ({ x: s.x + q.x / v.length, y: s.y + q.y / v.length }), { x: 0, y: 0 }); seed = v.reduce((b, q) => Math.hypot(q.x - c.x, q.y - c.y) < Math.hypot(b.x - c.x, b.y - c.y) ? q : b); }
      else seed = XG.fitCircle(v).c;
      S.armed = null; autoPlace(lmDef(id), seed); return;
    }
    S.armed = S.armed === id ? null : id;
    if (S.armed) toast(`自動検出：${AUTO[id]}してください`, 2500);
    refresh();
  }
  // 主要な項目（この順に置く）：回転中心（骨頭 または glenosphere）→ 上腕骨軸 → SFL → 肩峰外側端 → 大結節頂部。ほかはオプション
  const primaryIds = () => [$('mCategory').value === 'RSA' ? 'sphere' : 'head', 'shaft', 'sfl_m', 'sfl_l', 'acr_l', 'gt_s'];
  const isPrimary = (id) => primaryIds().includes(id);
  // 次の未入力の項目へ（主要の中、オプションの中でそれぞれ順に。分類で使わない項目は飛ばす）
  function advance() {
    const all = visibleLandmarks(), prim = isPrimary(S.active);
    const vis = all.filter((d) => isPrimary(d.id) === prim);
    const i = vis.findIndex((d) => d.id === S.active);
    for (let k = 1; k <= vis.length; k++) {
      const d = vis[(i + k) % vis.length];
      if (!S.lm[d.id]) { S.active = d.id; return; }
    }
  }
  function visibleLandmarks() {
    const cat = $('mCategory').value, calMode = $('calMode').value, prim = primaryIds();
    const rest = LM.filter((d) => {
      if (prim.includes(d.id)) return false;
      if (d.cats) return d.cats.includes(cat) || S.lm[d.id];
      if (d.group === '較正') return calMode === 'twoPoint' || S.lm[d.id];
      return true;
    });
    return [...prim.map(lmDef), ...rest];
  }

  $('btnUndoPt').onclick = () => {
    const v = S.lm[S.active];
    if (Array.isArray(v) && v.length) { v.pop(); if (!v.length) delete S.lm[S.active]; } else delete S.lm[S.active];
    forgetAuto(S.active);
    refresh();
  };
  $('btnClearLm').onclick = () => { delete S.lm[S.active]; forgetAuto(S.active); refresh(); };

  $('btnNextLm').onclick = () => { advance(); refresh(); };
  $('bandStart').oninput = draw;
  $('bandLen').oninput = draw;
  document.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input, textarea, select')) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); $('btnUndoPt').click(); }
    if (e.key === 'Tab') { e.preventDefault(); const vis = visibleLandmarks(); const i = vis.findIndex((d) => d.id === S.active); S.active = vis[(i + (e.shiftKey ? vis.length - 1 : 1)) % vis.length].id; refresh(); }
  });

  // ---- 左パネル ----
  function renderList() {
    const vis = visibleLandmarks(), prim = primaryIds();
    let html = '<div class="lmsub">主要（この順に）</div>', grp = '', inOpt = false;
    const optN = vis.length - prim.length, optDone = vis.filter((d) => !prim.includes(d.id) && S.lm[d.id]).length;
    if (!isPrimary(S.active)) S.optOpen = true;
    for (const d of vis) {
      if (!inOpt && !prim.includes(d.id)) {
        inOpt = true;
        html += `<details class="lmopt" id="lmOpt" ${S.optOpen ? 'open' : ''}><summary>オプション（${optDone}/${optN}）：CSA・LSA・DSA・AHI・ピラー原点など</summary>`;
      }
      if (inOpt && d.group !== grp) { grp = d.group; html += `<div class="grp" style="color:${groupCol[grp]}">${grp}</div>`; }
      const v = S.lm[d.id];
      const au = S.auto[d.id] || (d.id.startsWith('sfl_') && S.auto.sfl);
      const st = (au ? `<span class="auto ${au.conf}">自動</span>` : '') + (d.kind === 'pairs' ? (v ? `${Math.floor(v.length / 2)}組${v.length % 2 ? '+1' : ''}` : '') : d.kind !== 'pt' ? (v ? `${v.length}点` : '') : (v ? '✓' : ''));
      const ab = AUTO[d.id] ? `<button class="btn tiny autob ${S.armed === d.id ? 'armed' : ''}" data-auto="${d.id}" title="${AUTO[d.id]}">${S.armed === d.id ? 'タップ待ち' : '自動'}</button>` : '';
      const ord = inOpt ? '' : `<span class="ord">${prim.indexOf(d.id) + 1}</span>`;
      html += `<div class="lmrow"><button class="lm ${d.id === S.active ? 'active' : ''} ${v ? 'done' : ''}" data-id="${d.id}">
        ${ord}<span class="dot" style="background:${groupCol[d.group]}"></span>${d.label}<span class="st">${st}</span></button>${ab}</div>`;
    }
    if (inOpt) html += '</details>';
    $('lmList').innerHTML = html;
    if ($('lmOpt')) $('lmOpt').ontoggle = () => { S.optOpen = $('lmOpt').open; };
    $('lmList').querySelectorAll('.autob').forEach((b) => b.onclick = () => runAuto(b.dataset.auto));
    $('lmList').querySelectorAll('.lm').forEach((b) => b.onclick = () => { S.active = b.dataset.id; if (S.armed !== S.active) S.armed = null; refresh(); });
    const d = lmDef(S.active);
    const autoHint = S.armed === d.id ? { head: '自動：骨頭の中心あたりを1回タップ', sphere: '自動：glenosphere の中心あたりを1回タップ', pillar: '自動：外側縁の上を1回タップ（帯の中だと確実）', shaft: '自動：外科頚より遠位の骨幹の中ほどを1回タップ（骨頭を先に置くと確実）' }[d.id] : '';
    $('activeHint').innerHTML = S.img ? `<b>${d.label}</b>：${d.hint}${d.kind !== 'pt' ? '（タップで点を追加、終わったら「次へ」）' : ''}${autoHint ? `<br><span class="autohint">${autoHint}</span>` : ''}` : '画像を読み込んでから、項目を選んで画像上をタップ';
    const n = prim.filter((id) => S.lm[id]).length;
    $('lmCount').textContent = `主要 ${n}/${prim.length}`;
    $('sumLm').textContent = optDone ? `オプション ${optDone} 項目` : '';
    renderSummaries();
  }

  // ---- 計算と結果表示 ----
  function calInput() { return { mode: $('calMode').value, value: parseFloat($('calValue').value) || 0 }; }
  function recalc() { S.calc = XG.compute(S.lm, calInput(), { ref: S.ref && S.ref.snap }); }
  function fmt(v, unit) { return unit === '点' || Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1); }
  function renderResults() {
    const c = S.calc;
    if (!c || !c.results.length) { $('results').innerHTML = '<p class="hint">点を置くと必要な点がそろった項目から表示されます</p>'; }
    else {
      let html = '', grp = '';
      for (const r of c.results) {
        if (r.group !== grp) { grp = r.group; html += `<div class="grp">${grp}</div>`; }
        html += `<div class="res ${r.key === S.sel ? 'sel' : ''} ${r.hl ? 'hl' : ''}" data-key="${r.key}"><span class="k">${r.label}</span><span class="v">${fmt(r.value, r.unit)}<small>${r.unit}</small></span>${r.ref ? `<span class="ref">${r.ref}</span>` : ''}</div>`;
      }
      $('results').innerHTML = html;
      $('results').querySelectorAll('.res.hl').forEach((el) => el.onclick = () => {
        S.sel = S.sel === el.dataset.key ? null : el.dataset.key; renderResults(); draw();
      });
    }
    const m = $('calMode').value;
    $('calValue').placeholder = m === 'mmpx' ? 'mm/px' : 'mm';
    $('calValue').style.display = m === 'none' ? 'none' : '';
    $('calInfo').textContent = c && c.mmpx ? `${c.mmpx.toFixed(4)} mm/px（${c.calNote}）` :
      m === 'sphere' ? 'glenosphere の径（例 36 / 39 / 42）を入力し、輪郭を3点以上' :
      m === 'twoPoint' ? '較正 点A・B を置き、その実距離を入力' :
      m === 'mmpx' ? 'DICOM の PixelSpacing ÷ 拡大率 など' : '長さは px で表示（比較には較正が必要）';
    let fi = '';
    if (c && c.frame) {
      fi = `原点 O = SFL と ピラー線の交点<br>X = SFL（内側→外側が +）／ Y = 垂線（頭側が +）<br>交差角 ${c.frame.crossAngle.toFixed(1)}°`;
    } else fi = 'SFL 2点とピラー 2点を置くと座標系が決まります';
    $('frameInfo').innerHTML = fi;
  }
  function refresh() { recalc(); renderList(); renderResults(); draw(); }
  $('calMode').onchange = refresh;
  $('calValue').oninput = refresh;
  $('mCategory').onchange = () => {
    S.catManual = true; S.autoCat = null;
    // 回転中心の項目（骨頭⇄glenosphere）が入れ替わったら、空いている主要項目へ
    if (!visibleLandmarks().some((d) => d.id === S.active)) S.active = primaryIds()[0];
    refresh();
  };
  ['mCaseId', 'mSide', 'mDate', 'mView', 'mTiming', 'mNote'].forEach((id) => $(id).addEventListener('input', renderSummaries));

  // ---- 人工関節の自動判定（読み込み・台形補正のあと）：分類を RSA／TSA に。手で選んだ分類は変えない ----
  function checkImplant() {
    if (!S.img || S.catManual || !window.XA) return;
    let r = null;
    try { r = XA.detectImplant(S.img); } catch (e) { console.warn(e); return; }
    const cur = $('mCategory').value;
    if (r.implant) {
      $('mCategory').value = r.kind; S.autoCat = { kind: r.kind, conf: r.conf };
      toast(`人工関節あり：${CAT[r.kind]}と自動判定しました（${confText(r.conf)}）。違っていれば「分類」を変えてください`, 4000);
    } else if (cur === 'RSA' || cur === 'TSA') { $('mCategory').value = 'normal'; S.autoCat = { kind: 'none', conf: r.conf }; }
    else S.autoCat = { kind: 'none', conf: r.conf };
    if (!S.lm[S.active] || !visibleLandmarks().some((d) => d.id === S.active)) S.active = primaryIds()[0];
  }

  // ---- 左パネルの折りたたみ：開閉は覚えておき、たたんだときは見出しに中身の要約を出す ----
  const SECS = ['secMeta', 'secLm', 'secGrade', 'secCal'];
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できない環境 */ } };
  SECS.forEach((id) => {
    const v = lsGet('sx-open-' + id, null); if (v != null) $(id).open = v === '1';
    $(id).addEventListener('toggle', () => lsSet('sx-open-' + id, $(id).open ? '1' : '0'));
  });
  // 症例情報とランドマークをまとめて開く／たたむ（保存後・保存済み症例を開いたときはたたむ）
  function setSections(open) {
    ['secMeta', 'secLm'].forEach((id) => { $(id).open = open; });
    if (!open && S.calc && S.calc.mmpx) $('secCal').open = false; // 較正済みなら較正もたたむ
  }
  function renderSummaries() {
    const side = { R: '右', L: '左' }[$('mSide').value] || '';
    const cat = CAT[$('mCategory').value] || '';
    const au = S.autoCat && S.autoCat.kind !== 'none' ? '（自動）' : '';
    $('sumMeta').textContent = [$('mCaseId').value.trim() || 'IDなし', side, cat + au, $('mTiming').value.trim(), $('mDate').value].filter(Boolean).join('・');
    $('catInfo').innerHTML = S.autoCat ? (S.autoCat.kind === 'none' ? '<span class="catauto">自動判定</span> 人工関節は見つかりませんでした'
      : `<span class="catauto ${S.autoCat.conf}">自動判定</span> 金属を検出 → ${CAT[S.autoCat.kind]}（${confText(S.autoCat.conf)}）`) : '';
    const g = readGrades(), gs = GRADES.filter((id) => g[id.slice(1).toLowerCase()]).map((id) => `${$(id).parentElement.querySelector('label').textContent} ${g[id.slice(1).toLowerCase()]}`);
    $('sumGrade').textContent = gs.join('・');
    const c = S.calc;
    $('sumCal').textContent = c && c.mmpx ? `${c.mmpx.toFixed(4)} mm/px` : '未較正（px）';
  }
  $('mCaseId').onchange = fillRefSelect;
  ['optAxes', 'optAngles', 'optLabels', 'optAltFrame', 'optCor', 'optCorOnly'].forEach((id) => $(id).onchange = draw);

  // ---- 保存・読込 ----
  function resetCase() {
    S.lm = {}; S.auto = {}; S.trace = {}; S.armed = null; S.sel = null; S.caseKey = null; S.active = primaryIds()[0]; S.sourceUrl = ''; S.savedLm = '{}'; S.keystoned = false; S.catManual = false; S.autoCat = null;
    $('mCaseId').value = ''; $('mNote').value = ''; $('mTiming').value = ''; $('mSide').value = '';
    $('mDate').value = ''; $('mView').value = 'grashey';
    S.ref = null; writeGrades({}); fillRefSelect();
  }
  function imgBlob(c, type = 'image/jpeg', q = 0.92) { return new Promise((r) => c.toBlob(r, type, q)); }
  async function thumb() {
    const t = document.createElement('canvas'), k = 160 / Math.max(S.img.width, S.img.height);
    t.width = S.img.width * k; t.height = S.img.height * k;
    t.getContext('2d').drawImage(S.img, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.7);
  }
  function guessSide() {
    // SFL が画像の左→右へ向かう（外側が右）なら、正面像では左肩
    const a = S.lm.sfl_m, b = S.lm.sfl_l;
    if (!a || !b) return '';
    return b.x > a.x ? 'L' : 'R';
  }
  $('btnSave').onclick = async () => {
    if (!S.img) return toast('画像がありません');
    if (!$('mSide').value && guessSide()) $('mSide').value = guessSide();
    recalc();
    const rec = {
      caseId: $('mCaseId').value.trim(), side: $('mSide').value, date: $('mDate').value,
      category: $('mCategory').value, view: $('mView').value, timing: $('mTiming').value.trim(), note: $('mNote').value.trim(),
      landmarks: JSON.parse(JSON.stringify(S.lm)), cal: calInput(),
      pillarBand: { start: parseFloat($('bandStart').value), len: parseFloat($('bandLen').value) },
      grades: readGrades(), refKey: S.ref ? S.ref.key : null, refSnap: S.ref ? S.ref.snap : null,
      asRef: S.calc.asRef,
      keystoned: !!S.keystoned,
      results: Object.fromEntries(S.calc.results.map((r) => [r.key, +r.value.toFixed(3)])),
      unit: S.calc.unit, mmpx: S.calc.mmpx,
      width: S.img.width, height: S.img.height,
      image: await imgBlob(S.img), thumb: await thumb(),
      sourceUrl: S.sourceUrl, schema: 1, updatedAt: new Date().toISOString(),
    };
    if (S.caseKey != null) {
      rec.key = S.caseKey;
      const old = await DB.get(S.caseKey);
      Object.assign(rec, { uid: old.uid || uuid(), createdAt: old.createdAt || rec.updatedAt, origin: old.origin || Sync.origin(), importedFrom: old.importedFrom });
    } else Object.assign(rec, { uid: uuid(), createdAt: rec.updatedAt, origin: Sync.origin() });
    rec.refUid = S.ref && S.ref.uid || null;
    S.caseKey = await DB.put(rec);
    S.savedLm = JSON.stringify(S.lm);
    setSections(false);
    toast('保存しました #' + S.caseKey + (Sync.on() ? '（数値は iCloud に送ります）' : ''));
    Sync.soon();
  };
  $('btnNew').onclick = async () => {
    if (isDirty() && !await ask('保存していないプロットは消えます。新規にしますか？', '新規にする')) return;
    resetCase(); S.img = null; refresh();
  };

  async function openCase(key) {
    const rec = await DB.get(key);
    if (!rec.image) { toast(`この症例の画像はこの端末にありません（${whereText(rec) || '所在不明'}）。数値は一覧・ダッシュボードで見られます`, 4500); return; }
    const url = URL.createObjectURL(rec.image), im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0); URL.revokeObjectURL(url);
      S.img = c; S.auto = {}; S.trace = {}; S.armed = null; S.sel = null; S.lm = rec.landmarks || {}; S.caseKey = rec.key; S.sourceUrl = rec.sourceUrl || ''; S.keystoned = !!rec.keystoned;
      S.savedLm = JSON.stringify(S.lm);
      $('mCaseId').value = rec.caseId || ''; $('mSide').value = rec.side || ''; $('mDate').value = rec.date || '';
      $('mCategory').value = rec.category || 'normal'; $('mView').value = rec.view || 'grashey'; $('mTiming').value = rec.timing || ''; $('mNote').value = rec.note || '';
      $('calMode').value = rec.cal?.mode || 'none'; $('calValue').value = rec.cal?.value || '';
      if (rec.pillarBand) { $('bandStart').value = rec.pillarBand.start; $('bandLen').value = rec.pillarBand.len; }
      writeGrades(rec.grades || {});
      S.ref = rec.refSnap ? { key: rec.refKey, uid: rec.refUid, snap: rec.refSnap } : null;
      fillRefSelect();
      S.catManual = true; S.autoCat = null;
      S.active = primaryIds()[0]; if (S.lm[S.active]) advance();
      setSections(false);
      fitView(); refresh(); $('dlgCases').close();
    };
    im.src = url;
  }

  const CAT = { normal: '正常', OA: 'OA', CTA: '腱板/CTA', RSA: 'RSA術後', TSA: 'TSA/HHR', fracture: '骨折', other: 'その他' };
  // 画像の所在：この端末にあるか、iCloud で共有された各端末の「画像を持っている症例」の一覧から
  function whereList(r) {
    const w = (Sync.where[r.uid] || []).filter((n) => n !== Sync.name());
    return r.image ? ['この端末', ...w] : w;
  }
  const whereText = (r) => whereList(r).join('、') || (r.importedFrom ? `なし（${r.importedFrom} から取り込み）` : '');
  // 結果は global（肩甲骨側＋上腕骨側）を回転中心が sphere のものを優先して出す
  const pickR = (R, k) => R[k] != null ? R[k] : R['sphere_' + k] != null ? R['sphere_' + k] : R['head_' + k];
  const COLS = [['CSA', 'CSA', '°'], ['AHI', 'AHI', 'u'], ['LSA', 'LSA', '°'], ['DSA', 'DSA', '°'], ['glat_g', '外方化 g', 'u'], ['gdist_g', '下方化 g', 'u'], ['RSAangle', 'RSA角', '°']];
  S.sort = { k: 'updatedAt', dir: -1 };
  async function renderCases() {
    const q = $('caseFilter').value.trim().toLowerCase();
    const all = await DB.live();
    const list = all.filter((r) => !q || [r.caseId, CAT[r.category], r.note, r.timing, r.origin && r.origin.author, r.importedFrom].join(' ').toLowerCase().includes(q));
    const sk = S.sort.k, val = (r) => sk === 'where' ? whereText(r) : COLS.some(([k]) => k === sk) ? (pickR(r.results || {}, sk) ?? -Infinity) : (sk === 'author' ? r.origin && r.origin.author : r[sk]) ?? '';
    list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir; });
    $('caseCount').textContent = `${list.length} 件${q ? `（全 ${all.length} 件中）` : ''}`;
    const th = (k, t) => `<th class="sort" data-sort="${k}">${t}${S.sort.k === k ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    const head = `<tr><th></th>${th('caseId', '症例ID')}${th('side', '側')}${th('date', '撮影日')}${th('category', '分類')}${th('timing', '時期')}${COLS.map(([k, t]) => th(k, t)).join('')}${th('where', '画像の所在')}${th('author', '入力者')}${th('updatedAt', '更新')}<th></th></tr>`;
    const rows = list.map((r) => {
      const R = r.results || {}, u = r.unit || 'px', w = whereList(r);
      const cells = COLS.map(([k, , uu]) => { const v = pickR(R, k); return `<td class="n">${v == null ? '' : fmt(v, uu) + (uu === 'u' ? (u === 'mm' ? '' : ' px') : '')}</td>`; }).join('');
      return `<tr><td>${r.thumb ? `<img src="${r.thumb}" alt="">` : '<span class="noimg">画像なし</span>'}</td>
        <td>${esc(r.caseId || '(IDなし)')}</td><td>${{ R: '右', L: '左' }[r.side] || ''}</td><td>${r.date || ''}</td><td>${CAT[r.category] || ''}</td><td>${esc(r.timing || '')}</td>
        ${cells}<td class="where ${r.image ? 'here' : ''}">${esc(whereText(r) || '—')}</td><td>${esc(r.origin && r.origin.author || '')}</td><td>${(r.updatedAt || '').slice(0, 10)}</td>
        <td>${r.image ? `<button class="btn tiny" data-open="${r.key}">開く</button> ` : ''}<button class="btn tiny danger" data-del="${r.key}">削除</button></td></tr>`;
    }).join('');
    $('caseTable').innerHTML = head + (rows || `<tr><td colspan="${COLS.length + 11}" class="hint">保存された症例はありません</td></tr>`);
    $('caseTable').querySelectorAll('[data-sort]').forEach((t) => t.onclick = () => {
      S.sort = { k: t.dataset.sort, dir: S.sort.k === t.dataset.sort ? -S.sort.dir : (t.dataset.sort === 'updatedAt' ? -1 : 1) }; renderCases();
    });
    $('caseTable').querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openCase(+b.dataset.open));
    $('caseTable').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      const rec = await DB.get(+b.dataset.del);
      const msg = `${rec.caseId || '#' + rec.key} を削除します。${Sync.on() ? 'iCloud でつながったほかの端末からも消えます（画像も）。' : ''}元に戻せません。`;
      if (!await ask(msg, '削除', true)) return;
      await DB.put({ key: rec.key, uid: rec.uid || uuid(), deleted: true, updatedAt: new Date().toISOString() });
      if (S.caseKey === rec.key) S.caseKey = null;
      renderCases(); Sync.soon();
    });
    renderSync();
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('btnCases').onclick = () => { renderCases(); $('dlgCases').showModal(); Sync.run().then(() => { if ($('dlgCases').open) renderCases(); }); };
  $('btnCloseCases').onclick = () => $('dlgCases').close();
  $('caseFilter').oninput = renderCases;

  // ---- iCloud 同期（数値のみ）----
  // 各端末が iCloud コンテナに自分のファイル（dev-<端末ID>.json）だけを書き、ほかの端末のファイルは読むだけ。
  // ファイルには画像・サムネイルを除いた全症例と、この端末に画像がある症例の uid を入れる。同じ症例は更新日時の新しいほうを採る。
  const Sync = {
    id: lsGet('sx-device-id', ''), busy: false, timer: 0, status: '', err: false,
    where: (() => { try { return JSON.parse(lsGet('sx-where', '{}')); } catch { return {}; } })(),
    name: () => lsGet('sx-device-name', '') || Sync.defName || 'この端末',
    author: () => lsGet('sx-author', ''),
    on: () => !!nativeExport && lsGet('sx-icloud', 'on') !== 'off',
    origin: () => ({ deviceId: Sync.id, deviceName: Sync.name(), author: Sync.author() }),
    soon() { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 1500); },
    async run() {
      if (!this.on() || this.busy || !DB.db) { renderSync(); return; }
      this.busy = true; this.status = '同期中…'; this.err = false; renderSync();
      try {
        const st = await callNative('icloudStatus');
        if (!this.defName && st.deviceName) this.defName = st.deviceName;
        if (!st.available) throw new Error('iCloud が使えません（設定で iCloud にサインインし、iCloud Drive をオンにしてください）');
        const rd = await callNative('icloudReadAll');
        const files = (rd.files || []).map((f) => { try { return JSON.parse(f.text); } catch { return null; } }).filter((f) => f && f.app === 'shoulder-xray');
        const local = await DB.all(), byUid = new Map(local.map((r) => [r.uid, r]));
        let changed = 0;
        for (const f of files) {
          if (f.deviceId === this.id) continue;
          for (const rem of f.records || []) {
            if (!rem.uid) continue;
            const l = byUid.get(rem.uid);
            if (l && !((rem.updatedAt || '') > (l.updatedAt || ''))) continue;
            const rec = rem.deleted ? { uid: rem.uid, deleted: true, updatedAt: rem.updatedAt }
              : { ...rem, image: l && l.image || null, thumb: l && l.thumb || null };
            if (l) rec.key = l.key;
            rec.key = await DB.put(rec); byUid.set(rec.uid, rec); changed++;
          }
        }
        const mine = [...byUid.values()];
        const out = { app: 'shoulder-xray', kind: 'device', schema: 1, deviceId: this.id, deviceName: this.name(), updatedAt: new Date().toISOString(),
          records: mine.map(numeric), images: mine.filter((r) => r.image && !r.deleted).map((r) => r.uid) };
        await callNative('icloudWrite', { name: `dev-${this.id}.json`, text: JSON.stringify(out) });
        const where = {};
        for (const f of [...files.filter((f) => f.deviceId !== this.id), out]) for (const u of f.images || []) (where[u] = where[u] || []).push(f.deviceId === this.id ? this.name() : f.deviceName || '別の端末');
        this.where = where; lsSet('sx-where', JSON.stringify(where));
        const others = files.filter((f) => f.deviceId !== this.id).length;
        this.status = `iCloud 同期 ${new Date().toLocaleTimeString().slice(0, 5)}（ほかの端末 ${others} 台${changed ? `・${changed} 件更新` : ''}${rd.pending ? `・${rd.pending} 台分をダウンロード中` : ''}）`;
        if (rd.pending) setTimeout(() => this.run(), 8000);
        if (changed) { fillRefSelect(); if ($('dlgCases').open) renderCases(); if ($('dlgDash').open) renderDash(); }
      } catch (e) { this.status = (e && e.message) || String(e); this.err = true; }
      this.busy = false; renderSync();
    },
  };
  if (!Sync.id) { Sync.id = uuid().slice(0, 8); lsSet('sx-device-id', Sync.id); }
  const numeric = (r) => { const { image, thumb, key, ...rest } = r; return rest; };
  function renderSync() {
    const el = $('syncStatus'); if (!el) return;
    el.textContent = !nativeExport ? 'iCloud 同期は iPhone・iPad・Mac アプリでのみ使えます（Windows・ブラウザ版はこの端末内だけ。ほかの端末とは一覧表の書き出し・読み込みでやり取りします）' : !Sync.on() ? 'iCloud 同期はオフです' : Sync.status || 'iCloud 同期待ち';
    el.className = Sync.err ? 'err' : '';
    $('btnSyncNow').hidden = !Sync.on();
    $('setIcloud').checked = Sync.on(); $('setIcloud').disabled = !nativeExport;
    if (document.activeElement !== $('setDevName')) $('setDevName').value = lsGet('sx-device-name', '') || '';
    $('setDevName').placeholder = Sync.defName || '例：外来 iPad';
    if (document.activeElement !== $('setAuthor')) $('setAuthor').value = Sync.author();
  }
  $('btnSyncNow').onclick = () => Sync.run();
  $('setIcloud').onchange = (e) => { lsSet('sx-icloud', e.target.checked ? 'on' : 'off'); Sync.status = ''; renderSync(); Sync.run(); };
  $('setDevName').onchange = (e) => { lsSet('sx-device-name', e.target.value.trim()); Sync.soon(); };
  $('setAuthor').onchange = (e) => lsSet('sx-author', e.target.value.trim());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.soon(); });

  // iOS アプリでは <a download> が使えないので、ネイティブの共有シート（ios/App/App/XrayExportPlugin.swift）で書き出す（nativeExport は先頭で定義）
  async function download(name, blob) {
    if (nativeExport) {
      const data = (await b64(blob)).split(',')[1];
      try { await nativeExport.share({ name, data }); } catch (e) { toast('書き出せませんでした: ' + (e.message || e), 4000); }
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  const csvQ = (v) => v == null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const csvText = (rows) => '﻿' + rows.map((r) => r.map(csvQ).join(',')).join('\n');
  // 一覧表（CSV）：1行1症例。最後の record_json 列に点・較正などをすべて入れ、読み込んだ側で計算し直せるようにする（画像は入れない）
  const META = ['uid', 'caseId', 'side', 'date', 'category', 'view', 'timing', 'note', 'author', 'device', 'imageAt', 'unit', 'mmpx', 'refUid', 'keystoned', 'updatedAt'];
  $('btnExportCsv').onclick = async () => {
    const all = await DB.live();
    const rkeys = [...new Set(all.flatMap((r) => Object.keys(r.results || {})))];
    const lkeys = LM.filter((d) => d.kind === 'pt').map((d) => d.id);
    const gkeys = GRADES.map((id) => id.slice(1).toLowerCase());
    const head = [...META, ...gkeys.map((k) => 'g_' + k), ...rkeys, ...lkeys.flatMap((k) => [k + '_u', k + '_v']), 'record_json'];
    const rows = all.map((r) => [r.uid, r.caseId, r.side, r.date, r.category, r.view, r.timing, r.note, r.origin && r.origin.author, r.origin && r.origin.deviceName,
      whereText(r), r.unit, r.mmpx, r.refUid, r.keystoned ? 1 : '', r.updatedAt,
      ...gkeys.map((k) => r.grades && r.grades[k]),
      ...rkeys.map((k) => r.results && r.results[k]),
      ...lkeys.flatMap((k) => { const p = r.landmarks && r.landmarks[k]; return p && !Array.isArray(p) ? [p.x.toFixed(1), p.y.toFixed(1)] : ['', '']; }),
      JSON.stringify(numeric(r))]);
    download(`shoulder-xray-${stamp()}.csv`, new Blob([csvText([head, ...rows])], { type: 'text/csv' }));
  };
  const b64 = (blob) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
  $('btnExportJson').onclick = async () => {
    const all = await DB.live();
    const out = await Promise.all(all.map(async (r) => ({ ...r, image: r.image ? await b64(r.image) : null })));
    download(`shoulder-xray-backup-${stamp()}.json`, new Blob([JSON.stringify({ app: 'shoulder-xray', schema: 1, cases: out })], { type: 'application/json' }));
  };
  // CSV を行×列に（引用符・改行入りのセルに対応）
  function parseCSV(t) {
    t = t.replace(/^﻿/, '');
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x !== ''));
  }
  // record_json のない CSV（旧版・手で作った表）は列から組み立てる
  function recFromRow(o, head) {
    const num = (v) => v === '' || v == null || isNaN(+v) ? null : +v;
    const r = { uid: o.uid || null, caseId: o.caseId || '', side: o.side || '', date: o.date || '', category: o.category || 'other', view: o.view || '',
      timing: o.timing || '', note: o.note || '', unit: o.unit || '', mmpx: num(o.mmpx), keystoned: o.keystoned === '1', updatedAt: o.updatedAt || '',
      origin: { author: o.author || '', deviceName: o.device || '' }, grades: {}, results: {}, landmarks: {} };
    const skip = new Set([...META, 'key', 'refKey', 'record_json']);
    for (const h of head) {
      if (skip.has(h)) continue;
      if (h.startsWith('g_')) { if (o[h]) r.grades[h.slice(2)] = o[h]; continue; }
      const m = h.match(/^(.+)_([uv])$/);
      if (m && lmDef(m[1])) { if (o[h] !== '') { const p = r.landmarks[m[1]] = r.landmarks[m[1]] || {}; p[m[2] === 'u' ? 'x' : 'y'] = +o[h]; } continue; }
      if (GRADES.some((id) => id.slice(1).toLowerCase() === h)) { if (o[h]) r.grades[h] = o[h]; continue; }
      if (num(o[h]) != null) r.results[h] = num(o[h]);
    }
    return r;
  }
  // 同じ症例か：uid が同じ、または 症例情報＋計測値 がすべて同じ
  const fingerprint = (r) => JSON.stringify([r.caseId || '', r.side || '', r.date || '', r.category || '', r.view || '', r.timing || '',
    Object.entries(r.results || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${(+v).toFixed(2)}`)]);
  async function importRecords(recs, fileName) {
    const all = await DB.all(), uids = new Map(all.map((r) => [r.uid, r])), fps = new Set(all.filter((r) => !r.deleted).map(fingerprint));
    let add = 0, dup = 0;
    for (const r0 of recs) {
      const r = { ...r0 }; delete r.key;
      const old = r.uid && uids.get(r.uid);
      if ((old && !old.deleted) || fps.has(fingerprint(r))) { dup++; continue; }
      if (!r.uid) r.uid = uuid();
      r.importedFrom = r.importedFrom || fileName; r.importedAt = new Date().toISOString();
      r.updatedAt = r.updatedAt || r.importedAt; r.createdAt = r.createdAt || r.updatedAt;
      if (old) { r.key = old.key; if (!(r.updatedAt > old.updatedAt)) r.updatedAt = r.importedAt; } // 削除済みのものは取り込みで戻す
      r.key = await DB.put(r); uids.set(r.uid, r); fps.add(fingerprint(r)); add++;
    }
    return { add, dup };
  }
  $('importFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const text = await f.text();
      let recs = [];
      if (/^\s*[{[]/.test(text)) {
        const j = JSON.parse(text);
        for (const r of j.cases || []) recs.push({ ...r, image: r.image ? await (await fetch(r.image)).blob() : null });
      } else {
        const rows = parseCSV(text), head = rows.shift().map((h) => h.trim());
        if (!head.includes('caseId')) throw new Error('この アプリの一覧表（CSV）ではないようです');
        for (const row of rows) {
          const o = Object.fromEntries(head.map((h, i) => [h, row[i] == null ? '' : row[i]]));
          let r = null;
          if (o.record_json) { try { r = JSON.parse(o.record_json); } catch { r = null; } }
          recs.push(r && typeof r === 'object' ? { ...r, image: null, thumb: null } : recFromRow(o, head));
        }
      }
      const { add, dup } = await importRecords(recs, f.name);
      toast(`${f.name}：${add} 件を追加、重複 ${dup} 件は読み込みませんでした`, 4500);
      renderCases(); fillRefSelect(); if (add) Sync.soon();
    } catch (err) { toast('読み込みに失敗しました: ' + err.message, 4500); }
  };

  // ---- 統計ダッシュボード ----
  // 保存された点から今の計算式で計算し直す（定義を直したあとでも全症例が同じ式になる）。点のない取り込みデータは保存時の値
  const dashCache = new Map();
  function measuresOf(r) {
    const ck = r.uid + '|' + r.updatedAt;
    if (dashCache.has(ck)) return dashCache.get(ck);
    const out = {};
    let ok = false;
    if (r.landmarks && Object.keys(r.landmarks).length) {
      try {
        const c = XG.compute(r.landmarks, r.cal || { mode: 'none', value: 0 }, { ref: r.refSnap });
        for (const x of c.results) out[x.key] = { v: x.value, unit: x.unit, label: x.label, group: x.group };
        ok = true;
      } catch (e) { console.warn(e); }
    }
    if (!ok) for (const [k, v] of Object.entries(r.results || {})) if (Number.isFinite(+v)) out[k] = { v: +v, unit: null, label: null, group: null };
    dashCache.set(ck, out);
    return out;
  }
  const D = { recs: [], info: new Map() };
  const quant = (s, p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  function stats(vs) {
    const n = vs.length; if (!n) return null;
    const s = [...vs].sort((a, b) => a - b), mean = vs.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { n, mean, sd, med: quant(s, 0.5), q1: quant(s, 0.25), q3: quant(s, 0.75), min: s[0], max: s[n - 1] };
  }
  // 参考の検定：2群は Welch の t 検定、3群以上は一元配置分散分析。p 値は正則化不完全ベータ関数から
  function betacf(a, b, x) {
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d;
      const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-12) break;
    }
    return h;
  }
  function lgamma(z) {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let x = z, y = z, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let ser = 1.000000000190015; for (const c of g) ser += c / ++y;
    return -t + Math.log(2.5066282746310005 * ser / x);
  }
  function ibeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  function testGroups(gs) {
    const g = gs.filter((x) => x.st && x.st.n >= 2);
    if (g.length < 2) return '';
    if (g.length === 2) {
      const [a, b] = g.map((x) => x.st), va = a.sd ** 2 / a.n, vb = b.sd ** 2 / b.n;
      if (va + vb === 0) return '';
      const t = (a.mean - b.mean) / Math.sqrt(va + vb), df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
      return `参考：Welch の t 検定 t=${t.toFixed(2)}, df=${df.toFixed(1)}, p${fmtP(ibeta(df / (df + t * t), df / 2, 0.5))}`;
    }
    const N = g.reduce((s, x) => s + x.st.n, 0), M = g.reduce((s, x) => s + x.st.mean * x.st.n, 0) / N;
    const ssb = g.reduce((s, x) => s + x.st.n * (x.st.mean - M) ** 2, 0), ssw = g.reduce((s, x) => s + (x.st.n - 1) * x.st.sd ** 2, 0);
    const d1 = g.length - 1, d2 = N - g.length; if (d2 < 1 || ssw === 0) return '';
    const F = (ssb / d1) / (ssw / d2);
    return `参考：一元配置分散分析 F(${d1}, ${d2})=${F.toFixed(2)}, p${fmtP(ibeta(d2 / (d2 + d1 * F), d2 / 2, d1 / 2))}`;
  }
  const fmtP = (p) => p < 0.001 ? '<0.001' : '=' + p.toFixed(3);
  const f2 = (v) => v == null || !Number.isFinite(v) ? '' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);

  async function openDash() {
    D.recs = await DB.live();
    // 項目の名前と単位（計算し直した症例から集める）
    D.info = new Map();
    for (const r of D.recs) for (const [k, m] of Object.entries(measuresOf(r))) if (m.label && !D.info.has(k)) D.info.set(k, { label: m.label, group: m.group, unit: m.unit });
    const cats = [...new Set(D.recs.map((r) => r.category || 'other'))];
    if (!D.cats) D.cats = new Set(cats);
    $('dCats').innerHTML = cats.map((c) => `<label class="${D.cats.has(c) ? 'on' : ''}"><input type="checkbox" value="${c}" ${D.cats.has(c) ? 'checked' : ''}>${CAT[c] || c}</label>`).join('');
    $('dCats').querySelectorAll('input').forEach((i) => i.onchange = () => { i.checked ? D.cats.add(i.value) : D.cats.delete(i.value); i.parentElement.classList.toggle('on', i.checked); renderDash(); });
    const views = [...new Set(D.recs.map((r) => r.view).filter(Boolean))], vsel = $('dView').value;
    const VIEW = { grashey: '正面（Grashey）', ap: '正面（AP）', axillary: '軸位', yview: 'Scapular Y', ct: 'CT', other: 'その他' };
    $('dView').innerHTML = '<option value="">すべて</option>' + views.map((v) => `<option value="${v}">${VIEW[v] || v}</option>`).join('');
    $('dView').value = vsel;
    renderDash();
    $('dlgDash').showModal();
  }
  // 絞り込んだ症例ごとの値。長さは mm の症例だけ（未較正 px は混ぜない）
  function dashRows() {
    const side = $('dSide').value, view = $('dView').value, tm = $('dTiming').value.trim().toLowerCase();
    return D.recs.filter((r) => D.cats.has(r.category || 'other') && (!side || r.side === side) && (!view || r.view === view) && (!tm || (r.timing || '').toLowerCase().includes(tm)))
      .map((r) => ({ r, m: measuresOf(r) }));
  }
  // 長さの項目か（計算し直した症例の単位が mm/px）。取り込んだだけの値は症例の単位（unit 列）に従う
  const isLen = (k) => { const u = (D.info.get(k) || {}).unit; return u === 'mm' || u === 'px'; };
  const valOf = (row, k) => {
    const m = row.m[k]; if (!m || !Number.isFinite(m.v)) return null;
    const u = m.unit != null ? m.unit : isLen(k) ? row.r.unit : '';
    return u === 'px' || (isLen(k) && u !== 'mm') ? null : m.v;
  };
  const unitOf = (rows, k) => isLen(k) ? 'mm' : ((D.info.get(k) || {}).unit || '');
  const groupKey = (r, g) => g === 'category' ? (CAT[r.category] || r.category || '—') : g === 'side' ? ({ R: '右', L: '左' }[r.side] || '側なし') : g === 'author' ? (r.origin && r.origin.author || '入力者なし') : g === 'timing' ? (r.timing || '時期なし') : '全体';
  function renderDash() {
    const rows = dashRows(), g = $('dGroup').value;
    $('dN').textContent = `${rows.length} 症例`;
    // 項目の選択肢（値のある症例数つき）
    const keys = [...D.info.keys()].filter((k) => rows.some((x) => valOf(x, k) != null));
    for (const k of new Set(rows.flatMap((x) => Object.keys(x.m)))) if (!D.info.has(k) && rows.some((x) => valOf(x, k) != null)) keys.push(k);
    const lab = (k) => (D.info.get(k) || {}).label || k, grp = (k) => (D.info.get(k) || {}).group || '取り込み';
    const opt = (k) => `<option value="${k}">${grp(k)}：${lab(k)}（${rows.filter((x) => valOf(x, k) != null).length}）</option>`;
    const cur = $('dMeasure').value || (keys.includes('CSA') ? 'CSA' : keys[0]), curY = $('dMeasureY').value;
    $('dMeasure').innerHTML = keys.map(opt).join(''); $('dMeasure').value = keys.includes(cur) ? cur : keys[0] || '';
    $('dMeasureY').innerHTML = '<option value="">選ばない</option>' + keys.map(opt).join(''); $('dMeasureY').value = keys.includes(curY) ? curY : '';
    // 全項目の要約
    D.summary = keys.map((k) => ({ k, label: lab(k), group: grp(k), unit: unitOf(rows, k), st: stats(rows.map((x) => valOf(x, k)).filter((v) => v != null)) }));
    $('dSummary').innerHTML = '<tr><th>区分</th><th>項目</th><th>n</th><th>平均</th><th>SD</th><th>中央値</th><th>最小</th><th>最大</th></tr>' +
      D.summary.map((x) => `<tr data-k="${x.k}" style="cursor:pointer"><td>${esc(x.group)}</td><td>${esc(x.label)}${x.unit ? ` <small class="mono">${x.unit}</small>` : ''}</td><td class="n">${x.st.n}</td><td class="n">${f2(x.st.mean)}</td><td class="n">${f2(x.st.sd)}</td><td class="n">${f2(x.st.med)}</td><td class="n">${f2(x.st.min)}</td><td class="n">${f2(x.st.max)}</td></tr>`).join('');
    $('dSummary').querySelectorAll('tr[data-k]').forEach((t) => t.onclick = () => { $('dMeasure').value = t.dataset.k; renderDash(); });
    const k = $('dMeasure').value;
    if (!k) { $('dChart').innerHTML = '<p class="empty2">集計できる症例がありません。症例を保存するか、一覧表を読み込んでください</p>'; $('dGroups').innerHTML = ''; $('dScatter').innerHTML = ''; return; }
    // 群ごと
    const gmap = new Map();
    for (const x of rows) { const v = valOf(x, k); if (v == null) continue; const gk = groupKey(x.r, g); if (!gmap.has(gk)) gmap.set(gk, []); gmap.get(gk).push({ v, r: x.r }); }
    const groups = [...gmap.entries()].map(([name, pts]) => ({ name, pts, st: stats(pts.map((p) => p.v)) }));
    const unit = unitOf(rows, k);
    D.groups = { k, label: lab(k), unit, groups };
    $('dChart').innerHTML = stripPlot(groups, lab(k), unit);
    $('dGroups').innerHTML = `<table class="dtable"><tr><th>${g ? { category: '分類', timing: '時期', side: '側', author: '入力者' }[g] : ''}</th><th>n</th><th>平均 ± SD</th><th>中央値 [IQR]</th><th>範囲</th></tr>` +
      groups.map((x) => `<tr><td>${esc(x.name)}</td><td class="n">${x.st.n}</td><td class="n">${f2(x.st.mean)} ± ${f2(x.st.sd)}</td><td class="n">${f2(x.st.med)} [${f2(x.st.q1)}–${f2(x.st.q3)}]</td><td class="n">${f2(x.st.min)}–${f2(x.st.max)}</td></tr>`).join('') +
      `</table><p class="hint">${testGroups(groups)}</p>`;
    const ky = $('dMeasureY').value;
    $('dScatter').innerHTML = ky ? scatter(rows, k, ky, lab(k), lab(ky), unit, unitOf(rows, ky)) : '';
    bindTips();
  }
  // 目盛り（1・2・5 刻み）
  function ticks(lo, hi, n = 5) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw);
    const a = Math.floor(lo / st) * st, out = []; for (let v = a; v <= hi + st * 0.5; v += st) out.push(+v.toFixed(10));
    return out;
  }
  const C = { dot: '#3987e5', text: '#e6edf3', sub: '#8b949e', grid: '#2a313c', surf: '#161b22' };
  const tipAttr = (r, txt) => `data-tip="${esc(`${r.caseId || '(IDなし)'}　${CAT[r.category] || ''} ${r.timing || ''}　${txt}`)}"`;
  // 群ごとの点（ずらして並べる）＋箱（四分位）＋中央値
  function stripPlot(groups, label, unit) {
    const all = groups.flatMap((x) => x.pts.map((p) => p.v)); if (!all.length) return '';
    const T = ticks(Math.min(...all), Math.max(...all)), lo = T[0], hi = T[T.length - 1];
    const W = 560, H = 260, L = 48, R = 12, top = 14, B = 44, cw = (W - L - R) / groups.length;
    const y = (v) => top + (H - top - B) * (1 - (v - lo) / (hi - lo || 1));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} の分布">`;
    for (const t of T) svg += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${C.grid}" stroke-width="1"/><text x="${L - 6}" y="${y(t) + 4}" fill="${C.sub}" font-size="11" text-anchor="end">${f2(t)}</text>`;
    svg += `<text x="12" y="${top + (H - top - B) / 2}" fill="${C.sub}" font-size="11" transform="rotate(-90 12 ${top + (H - top - B) / 2})" text-anchor="middle">${esc(label.replace(/（.*/, ''))}${unit ? ` (${unit})` : ''}</text>`;
    groups.forEach((gp, i) => {
      const cx = L + cw * (i + 0.5), bw = Math.min(46, cw * 0.5), s = gp.st;
      if (s.n >= 3) {
        svg += `<rect x="${cx - bw / 2}" y="${y(s.q3)}" width="${bw}" height="${Math.max(1, y(s.q1) - y(s.q3))}" rx="4" fill="none" stroke="${C.sub}" stroke-width="1.5"/>`;
        svg += `<line x1="${cx - bw / 2}" x2="${cx + bw / 2}" y1="${y(s.med)}" y2="${y(s.med)}" stroke="${C.text}" stroke-width="2"/>`;
      }
      const rnd = rng(i + 7);
      for (const p of gp.pts) {
        const jx = cx + (rnd() - 0.5) * Math.min(cw * 0.6, 60);
        svg += `<circle cx="${jx.toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" fill="${C.dot}" fill-opacity=".8" stroke="${C.surf}" stroke-width="1.5" ${tipAttr(p.r, `${f2(p.v)}${unit}`)}/>`;
      }
      svg += `<text x="${cx}" y="${H - B + 18}" fill="${C.text}" font-size="12" text-anchor="middle">${esc(gp.name.length > 12 ? gp.name.slice(0, 11) + '…' : gp.name)}</text>`;
      svg += `<text x="${cx}" y="${H - B + 33}" fill="${C.sub}" font-size="11" text-anchor="middle">n=${s.n}</text>`;
    });
    return svg + '</svg>';
  }
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  // 2項目の散布図と相関係数（Pearson）・回帰直線
  function scatter(rows, kx, ky, lx, ly, ux, uy) {
    const pts = rows.map((x) => ({ x: valOf(x, kx), y: valOf(x, ky), r: x.r })).filter((p) => p.x != null && p.y != null);
    if (pts.length < 2) return '<p class="empty2">両方の値がある症例が2例未満です</p>';
    const TX = ticks(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x))), TY = ticks(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)));
    const W = 560, H = 280, L = 48, R = 12, top = 14, B = 40;
    const X = (v) => L + (W - L - R) * (v - TX[0]) / (TX[TX.length - 1] - TX[0] || 1), Y = (v) => top + (H - top - B) * (1 - (v - TY[0]) / (TY[TY.length - 1] - TY[0] || 1));
    const n = pts.length, mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
    const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0), syy = pts.reduce((s, p) => s + (p.y - my) ** 2, 0), sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0, b = sxx ? sxy / sxx : 0;
    const tt = n > 2 && Math.abs(r) < 1 ? r * Math.sqrt((n - 2) / (1 - r * r)) : null;
    const pv = tt == null ? null : ibeta((n - 2) / (n - 2 + tt * tt), (n - 2) / 2, 0.5);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="散布図">`;
    for (const t of TY) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="${C.grid}"/><text x="${L - 6}" y="${Y(t) + 4}" fill="${C.sub}" font-size="11" text-anchor="end">${f2(t)}</text>`;
    for (const t of TX) svg += `<text x="${X(t)}" y="${H - B + 16}" fill="${C.sub}" font-size="11" text-anchor="middle">${f2(t)}</text>`;
    svg += `<line x1="${X(TX[0])}" x2="${X(TX[TX.length - 1])}" y1="${Y(my + b * (TX[0] - mx))}" y2="${Y(my + b * (TX[TX.length - 1] - mx))}" stroke="${C.sub}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    for (const p of pts) svg += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="4" fill="${C.dot}" fill-opacity=".8" stroke="${C.surf}" stroke-width="1.5" ${tipAttr(p.r, `${f2(p.x)}${ux} / ${f2(p.y)}${uy}`)}/>`;
    svg += `<text x="${(L + W - R) / 2}" y="${H - 6}" fill="${C.sub}" font-size="11" text-anchor="middle">${esc(lx.replace(/（.*/, ''))}${ux ? ` (${ux})` : ''}</text>`;
    svg += `<text x="12" y="${top + (H - top - B) / 2}" fill="${C.sub}" font-size="11" transform="rotate(-90 12 ${top + (H - top - B) / 2})" text-anchor="middle">${esc(ly.replace(/（.*/, ''))}${uy ? ` (${uy})` : ''}</text>`;
    svg += '</svg>';
    return svg + `<p class="hint">n=${n}　Pearson r=${r.toFixed(3)}${pv != null ? `（p${fmtP(pv)}）` : ''}　回帰：y = ${f2(b)}x ${my - b * mx >= 0 ? '+' : '−'} ${f2(Math.abs(my - b * mx))}</p>`;
  }
  function bindTips() {
    const tip = $('dTip');
    $('dlgDash').querySelectorAll('[data-tip]').forEach((el) => {
      el.onpointerenter = (e) => { tip.textContent = el.dataset.tip; tip.hidden = false; el.setAttribute('r', 6); move(e); };
      el.onpointermove = (e) => move(e);
      el.onpointerleave = () => { tip.hidden = true; el.setAttribute('r', 4); };
    });
    function move(e) { tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px'; tip.style.top = (e.clientY - 34) + 'px'; }
  }
  $('btnDash').onclick = openDash;
  $('btnCloseDash').onclick = () => { $('dTip').hidden = true; $('dlgDash').close(); };
  ['dSide', 'dView', 'dGroup', 'dMeasure', 'dMeasureY'].forEach((id) => $(id).onchange = renderDash);
  $('dTiming').oninput = renderDash;
  $('btnDashCsv').onclick = () => {
    const rows = [['区分', '項目', 'key', '単位', 'n', '平均', 'SD', '中央値', 'Q1', 'Q3', '最小', '最大']];
    for (const x of D.summary || []) rows.push([x.group, x.label, x.k, x.unit, x.st.n, x.st.mean, x.st.sd, x.st.med, x.st.q1, x.st.q3, x.st.min, x.st.max].map((v) => typeof v === 'number' ? +v.toFixed(4) : v));
    if (D.groups) {
      rows.push([], [`群別：${D.groups.label}`, '', D.groups.k, D.groups.unit]);
      rows.push(['群', '', '', '', 'n', '平均', 'SD', '中央値', 'Q1', 'Q3', '最小', '最大']);
      for (const g of D.groups.groups) rows.push([g.name, '', '', '', g.st.n, ...[g.st.mean, g.st.sd, g.st.med, g.st.q1, g.st.q3, g.st.min, g.st.max].map((v) => +v.toFixed(4))]);
    }
    download(`shoulder-xray-stats-${stamp()}.csv`, new Blob([csvText(rows)], { type: 'text/csv' }));
  };

  // ---- 目視分類 ----
  const GRADES = ['gHamada', 'gSamilson', 'gWalch', 'gFavard', 'gSirveaux', 'gNeer', 'gLevy', 'gLazarus', 'gShield', 'gGartner'];
  const readGrades = () => Object.fromEntries(GRADES.map((id) => [id.slice(1).toLowerCase(), $(id).value]));
  const writeGrades = (g) => GRADES.forEach((id) => { $(id).value = g[id.slice(1).toLowerCase()] || ''; });
  GRADES.forEach((id) => $(id).addEventListener('change', renderSummaries));

  // 見本ボタン：分類ごとに模式図と自分の症例を並べ、選ぶとその値をセット
  GRADES.forEach((id) => {
    const b = document.createElement('button');
    b.className = 'btn tiny'; b.textContent = '見本'; b.type = 'button';
    b.onclick = () => openGuide(id);
    $(id).parentElement.appendChild(b);
  });
  $('btnHelp').onclick = () => { if (!$('helpFrame').src) $('helpFrame').src = 'help.html'; $('dlgHelp').showModal(); };
  $('btnCloseHelp').onclick = () => $('dlgHelp').close();
  async function openGuide(id) {
    const key = id.slice(1).toLowerCase(), C = XS.CLASSES[key];
    const mine = DB.db ? (await DB.live()).filter((r) => r.grades && r.grades[key] && r.thumb) : [];
    $('guideTitle').textContent = C.title;
    $('guideNote').textContent = C.note;
    $('guideCards').innerHTML = C.grades.map(([g, desc]) => {
      const ex = mine.filter((r) => r.grades[key] === g).slice(0, 4);
      return `<div class="gcard ${$(id).value === g ? 'sel' : ''}" data-g="${g}">${XS.render(key, g)}
        <div class="gh">${key === 'neer' ? g + '-part' : g}</div><div class="gd">${desc}</div>
        ${ex.length ? `<div class="mine">${ex.map((r) => `<img src="${r.thumb}" title="#${r.key} ${esc(r.caseId || '')}">`).join('')}</div>` : ''}</div>`;
    }).join('');
    $('guideCards').querySelectorAll('.gcard').forEach((c) => c.onclick = () => { $(id).value = c.dataset.g; $('dlgGuide').close(); });
    $('dlgGuide').showModal();
  }
  $('btnCloseGuide').onclick = () => $('dlgGuide').close();

  // ---- 基準症例（術前など）：本来の関節窩・骨頭中心をこの画像に写す ----
  async function fillRefSelect() {
    if (!DB.db) return;
    const all = (await DB.live()).filter((r) => r.key !== S.caseKey);
    const id = $('mCaseId').value.trim();
    all.sort((a, b) => ((b.caseId === id) - (a.caseId === id)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    $('mRef').innerHTML = '<option value="">なし</option>' + all.map((r) =>
      `<option value="${r.key}" ${r.asRef ? '' : 'disabled'}>#${r.key} ${esc(r.caseId || '')} ${CAT[r.category] || ''} ${esc(r.timing || '')}${r.asRef ? '' : '（基準に使えない）'}</option>`).join('');
    $('mRef').value = S.ref ? String(S.ref.key) : '';
    $('refInfo').textContent = S.ref ? (S.calc && S.calc.refGl ? '白の破線＝基準症例の関節窩、白い × ＝基準の骨頭中心' : '基準を写すには、この画像も SFL・ピラー・較正が必要') : '同じ患者の術前画像などを選ぶと、本来の関節窩に対するオフセットを計算';
  }
  $('mRef').onchange = async () => {
    const key = +$('mRef').value;
    if (!key) { S.ref = null; refresh(); fillRefSelect(); return; }
    const rec = await DB.get(key);
    S.ref = rec.asRef ? { key, uid: rec.uid, snap: rec.asRef } : null;
    refresh(); fillRefSelect();
  };

  // ---- 台形補正（スマホでモニター・フィルムを撮った画像） ----
  // 画像（フィルムやモニターの表示領域）の4隅を指定 → 射影変換で長方形に戻す
  S.mode = null; S.kq = [];
  function drawKeystone(g, T, z) {
    const q = S.kq.map(T);
    g.strokeStyle = '#ffeb3b'; g.lineWidth = 2 * z; g.setLineDash([6 * z, 4 * z]);
    if (q.length > 1) { g.beginPath(); q.forEach((t, i) => i ? g.lineTo(t.x, t.y) : g.moveTo(t.x, t.y)); if (q.length === 4) g.closePath(); g.stroke(); }
    g.setLineDash([]);
    q.forEach((t) => { g.fillStyle = '#ffeb3b'; g.beginPath(); g.arc(t.x, t.y, 7 * z, 0, 7); g.fill(); g.strokeStyle = '#000'; g.lineWidth = 2 * z; g.stroke(); });
  }
  function hitKeystone(sx, sy) {
    const z = dpr();
    let best = -1, bd = 18 * z;
    S.kq.forEach((p, i) => { const q = toScr(p), d = Math.hypot(q.x - sx * z, q.y - sy * z); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function updateKeystoneBar() {
    $('kbar').hidden = S.mode !== 'keystone';
    $('kMsg').textContent = S.kq.length < 4 ? `X線画像（フィルム／モニターの表示部分）の4隅をタップ：あと ${4 - S.kq.length} 点（縁の近くなら角に吸着します）`
      : S.kAuto ? '4隅を自動で見つけました。ずれていれば黄色の点をドラッグして直し「適用」' : '4隅を調整して「適用」';
    $('kApply').disabled = S.kq.length < 4;
    $('kRedo').hidden = S.kq.length === 0;
  }
  $('btnKeystone').onclick = () => {
    if (!S.img) return toast('画像がありません');
    S.mode = 'keystone'; S.kq = []; S.kAuto = false;
    updateKeystoneBar(); $('kMsg').textContent = 'X線の範囲の4隅を探しています…'; draw();
    // 表示を先に出してから検出する（端末によっては1秒ほどかかる）
    setTimeout(() => {
      if (S.mode !== 'keystone' || S.kq.length) return;
      let q = null;
      try { q = window.XA && XA.detectQuad(S.img); } catch (e) { console.warn(e); }
      if (q) { S.kq = q.pts; S.kAuto = true; }
      else toast('X線の範囲を自動で見つけられませんでした。4隅をタップしてください', 3500);
      updateKeystoneBar(); draw();
    }, 50);
  };
  $('kRedo').onclick = () => { S.kq = []; S.kAuto = false; updateKeystoneBar(); draw(); };
  $('kCancel').onclick = () => { S.mode = null; S.kq = []; updateKeystoneBar(); draw(); };
  $('kApply').onclick = () => {
    // 4点を 左上・右上・右下・左下 の順に並べる
    const c = S.kq.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    const q = [...S.kq].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
    // atan2 順は 左上(−135°)→右上→右下→左下
    const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = (D(q[0], q[1]) + D(q[3], q[2])) / 2, H = (D(q[0], q[3]) + D(q[1], q[2])) / 2;
    // 縦横比：入力があればそれ、無ければ4隅から本当の比を推定（斜めから撮ると見た目の比は狂う）
    const ar = parseAspect($('kAspect').value) || (window.XA && XA.rectAspect(q, S.img.width, S.img.height));
    if (ar) H = W / ar;
    const k = Math.min(1, 3000 / Math.max(W, H));
    W = Math.round(W * k); H = Math.round(H * k);
    const dst = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    const Hinv = homography(dst, q), Hfwd = homography(q, dst);
    S.img = warp(S.img, Hinv, W, H);
    const map = (p) => applyH(Hfwd, p);
    for (const key in S.lm) S.lm[key] = Array.isArray(S.lm[key]) ? S.lm[key].map(map) : map(S.lm[key]);
    S.mode = null; S.kq = []; updateKeystoneBar();
    S.keystoned = true; S.trace = {};
    checkImplant();
    fitView(); refresh();
    toast(`台形補正しました（${W}×${H}px）。長さの較正はこのあと行ってください`, 3500);
  };
  // "35:43" "14x17" "0.81" などを 幅/高さ に
  function parseAspect(s) {
    s = (s || '').trim(); if (!s) return null;
    const m = s.match(/^([\d.]+)\s*[:x×\/]\s*([\d.]+)$/i);
    const v = m ? +m[1] / +m[2] : +s;
    return v > 0 ? v : null;
  }
  // src の4点 → dst の4点 へ写す 3×3 射影行列（h33 = 1）
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8, M = A.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < n; i++) {
      let piv = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      [M[i], M[piv]] = [M[piv], M[i]];
      for (let k = 0; k < n; k++) { if (k === i) continue; const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
    }
    const h = M.map((r, i) => r[n] / r[i]);
    return [...h, 1];
  }
  function applyH(h, p) {
    const w = h[6] * p.x + h[7] * p.y + h[8];
    return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
  }
  // 出力の各画素について元画像の位置を求め、双線形補間で色を取る
  function warp(srcCanvas, Hinv, W, H) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const sd = srcCanvas.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const og = out.getContext('2d'), od = og.createImageData(W, H), o = od.data;
    const h = Hinv;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const w = h[6] * x + h[7] * y + h[8];
        const sx = (h[0] * x + h[1] * y + h[2]) / w, sy = (h[3] * x + h[4] * y + h[5]) / w;
        const di = (y * W + x) * 4;
        if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) { o[di + 3] = 255; continue; }
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          o[di + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
        }
        o[di + 3] = 255;
      }
    }
    og.putImageData(od, 0, 0);
    return out;
  }

  // ---- 起動 ----
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(stage);
  DB.open().then(async () => {
    for (const r of await DB.all()) if (!r.uid) { r.uid = uuid(); r.origin = r.origin || Sync.origin(); await DB.put(r); }
    fillRefSelect(); Sync.run();
  }).catch(() => toast('端末内の保存領域が使えません（プライベートブラウズでは保存できません）', 5000));
  window.__S = S; // デバッグ用
  resize(); refresh();
})();
