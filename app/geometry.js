// 計測の定義と幾何計算。画像座標は px（u 右向き, v 下向き）。
// UI から独立させてあるので、自動検出を足すときもここはそのまま使う。
(function (global) {
  'use strict';

  // kind: 'pt' = 1点, 'circle' = 輪郭上の3点以上（最小二乗で円当てはめ）, 'line' = 2点以上（直線当てはめ）,
  //       'pairs' = 同じ高さの両側皮質を1組として2組以上（中点を結んで骨軸）
  // cats: その分類のときだけ一覧に出す
  const LANDMARKS = [
    { id: 'sfl_m', group: '基準軸', kind: 'pt', label: 'SFL 内側点', hint: '棘上窩底の内側（肩甲骨内側縁寄り）' },
    { id: 'sfl_l', group: '基準軸', kind: 'pt', label: 'SFL 外側点', hint: '棘上窩底の外側（烏口突起基部・関節窩基部寄り）' },
    { id: 'pillar', group: '基準軸', kind: 'line', label: 'ピラー線（外側縁）', hint: '肩甲骨外側縁の最外側の皮質縁に沿って 4〜6 点。ノッチング・下方骨棘の範囲は避け、点線の帯（較正時）の中に置く' },
    { id: 'gl_s', group: '関節窩', kind: 'pt', label: '関節窩 上極', hint: '関節上結節（関節窩上縁）。術後は残存骨の上縁（CSA・LSA・DSA 共通）' },
    { id: 'gl_i', group: '関節窩', kind: 'pt', label: '関節窩 下極', hint: '関節窩下縁（骨棘の先端ではなく本来の縁）' },
    { id: 'gl_il', group: '関節窩', kind: 'pt', label: '関節窩 下部面', hint: 'RSA角用：下極から関節面の下1/3上の点（術後はベースプレート下縁の接触面）' },
    { id: 'acr_l', group: '肩峰', kind: 'pt', label: '肩峰 外側端', hint: '肩峰の最外側下縁（CSA・LSA・DSA 共通）' },
    { id: 'acr_under', group: '肩峰', kind: 'line', label: '肩峰 下面（輪郭）', hint: '肩峰下面の皮質を内側から外側端まで 3〜5 点。AHI（骨頭円との最短距離）・回転中心からの距離・LAA に使う' },
    { id: 'head', group: '上腕骨頭', kind: 'circle', label: '骨頭 輪郭（円）', hint: '骨頭の関節面輪郭を3点以上（広く散らす）' },
    { id: 'neck_s', group: '上腕骨頭', kind: 'pt', label: '解剖頚 上端', hint: '関節面と大結節の境目' },
    { id: 'neck_i', group: '上腕骨頭', kind: 'pt', label: '解剖頚 下端', hint: '関節面と内側 calcar の境目' },
    { id: 'gt_l', group: '上腕骨', kind: 'pt', label: '大結節 最外側点', hint: '大結節外側面の最も外側の点。LSA・DSA・肩峰指数・回転中心からの距離に使う' },
    { id: 'gt_s', group: '上腕骨', kind: 'pt', label: '大結節 頂部', hint: '大結節の最も頭側の点。上腕骨側の下方化（回転中心から骨軸方向に何 mm 下か）と HHH（骨頭頂部との高さの差）に使う' },
    { id: 'shaft', group: '上腕骨', kind: 'pairs', label: '骨幹 皮質（骨軸）', hint: '同じ高さで外側皮質→内側皮質を1組。近位と遠位で2組以上（外科頚より遠位）' },
    { id: 'delt', group: '上腕骨', kind: 'pt', label: '三角筋粗面 遠位端', hint: '三角筋粗面の最も遠位（末梢）の端。外側皮質の隆起が骨幹の輪郭に戻るところ。腕の長さ（肩峰外側端からの距離）用、写っていなければ空欄' },
    { id: 'sphere', group: 'インプラント', kind: 'circle', label: 'Glenosphere 輪郭（円）', hint: 'RSA術後：glenosphere の外縁を3点以上', cats: ['RSA'] },
    { id: 'scap_inf', group: '肩甲骨', kind: 'pt', label: '肩甲骨 下角', hint: 'GPA（glenopolar angle）用' },
    { id: 'cal_a', group: '較正', kind: 'pt', label: '較正 点A', hint: '既知距離の一端（マーカー球の両端など）' },
    { id: 'cal_b', group: '較正', kind: 'pt', label: '較正 点B', hint: '既知距離のもう一端' },
  ];

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const len = (a) => Math.hypot(a.x, a.y);
  const norm = (a) => { const l = len(a); return { x: a.x / l, y: a.y / l }; };
  const dist = (a, b) => len(sub(a, b));
  const deg = (r) => r * 180 / Math.PI;

  // 頂点 v で、v→a と v→b がなす角（0〜180°）
  function angleAt(v, a, b) {
    const p = sub(a, v), q = sub(b, v);
    return deg(Math.atan2(Math.abs(cross(p, q)), dot(p, q)));
  }

  // 2直線（各2点）の交点。ほぼ平行なら null
  function intersect(p1, p2, q1, q2) {
    const r = sub(p2, p1), s = sub(q2, q1);
    const den = cross(r, s);
    if (Math.abs(den) < 1e-9) return null;
    const t = cross(sub(q1, p1), s) / den;
    return add(p1, mul(r, t));
  }

  // 円の最小二乗当てはめ（Kåsa 法）。残差 RMS も返す
  function fitCircle(pts) {
    if (!pts || pts.length < 3) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
    for (const p of pts) {
      const x = p.x - mx, y = p.y - my, z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
    }
    // [sxx sxy sx][a]   [sxz]
    // [sxy syy sy][b] = [syz]   中心 = (a/2, b/2)
    // [sx  sy  n ][c]   [sz ]
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], B = [sxz, syz, sz];
    const sol = solve3(A, B);
    if (!sol) return null;
    const cx = sol[0] / 2, cy = sol[1] / 2;
    const r = Math.sqrt(sol[2] + cx * cx + cy * cy);
    const c = { x: cx + mx, y: cy + my };
    const rms = Math.sqrt(pts.reduce((s, p) => s + (dist(p, c) - r) ** 2, 0) / n);
    return { c, r, rms };
  }

  // 直線の当てはめ（主成分＝直交距離の最小二乗）。重心 c と単位方向 d、垂直残差 RMS
  function fitLine(pts) {
    if (!pts || pts.length < 2) return null;
    const n = pts.length;
    const c = { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const x = p.x - c.x, y = p.y - c.y; sxx += x * x; syy += y * y; sxy += x * y; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const d = { x: Math.cos(th), y: Math.sin(th) };
    const rms = Math.sqrt(pts.reduce((s, p) => s + cross(d, sub(p, c)) ** 2, 0) / n);
    return { c, d, p1: c, p2: add(c, d), rms };
  }

  function rotate(v, rad) {
    const cs = Math.cos(rad), sn = Math.sin(rad);
    return { x: v.x * cs - v.y * sn, y: v.x * sn + v.y * cs };
  }

  function solve3(A, B) {
    const m = A.map((row, i) => [...row, B[i]]);
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
      if (Math.abs(m[p][i]) < 1e-12) return null;
      [m[i], m[p]] = [m[p], m[i]];
      for (let k = 0; k < 3; k++) {
        if (k === i) continue;
        const f = m[k][i] / m[i][i];
        for (let j = i; j < 4; j++) m[k][j] -= f * m[i][j];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }

  // SFL を X 軸（内側→外側が +）、垂線を Y 軸（頭側が +）とする座標系。
  // 原点は SFL と別の直線の交点。画像の左右（右肩/左肩）は SFL の向きで自動的に吸収される。
  function makeFrame(sflM, sflL, q1, q2) {
    const ex = norm(sub(sflL, sflM));
    let ey = { x: ex.y, y: -ex.x };
    if (ey.y > 0) ey = mul(ey, -1); // 画像の上（v が小さい側）を +Y
    const o = intersect(sflM, sflL, q1, q2);
    if (!o) return null;
    const crossAngle = angleBetweenLines(sub(sflL, sflM), sub(q2, q1));
    return {
      o, ex, ey, crossAngle,
      toLocal: (p) => { const d = sub(p, o); return { x: dot(d, ex), y: dot(d, ey) }; },
      toImage: (l) => add(o, add(mul(ex, l.x), mul(ey, l.y))),
    };
  }

  // 2直線の交差角（0〜90°）
  function angleBetweenLines(a, b) {
    const t = deg(Math.atan2(Math.abs(cross(a, b)), dot(a, b)));
    return t > 90 ? 180 - t : t;
  }

  // 点 p と折れ線（点列）の最短距離
  function distToPolyline(p, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], ab = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
      best = Math.min(best, dist(p, add(a, mul(ab, t))));
    }
    return pts.length === 1 ? dist(p, pts[0]) : best;
  }

  // 折れ線上で p に最も近い点
  function closestOnPolyline(p, pts) {
    let best = pts[0], bd = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], ab = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1))), q = add(a, mul(ab, t)), d = dist(p, q);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  // 点 p と直線 a-b の符号なし距離
  function distToLine(p, a, b) {
    return Math.abs(cross(sub(b, a), sub(p, a))) / dist(a, b);
  }

  // lm: { id: {x,y} | [{x,y},...] }, cal: { mode, value }
  function compute(lm, cal, opts = {}) {
    const P = (id) => (lm[id] && !Array.isArray(lm[id])) ? lm[id] : null;
    const C = (id) => Array.isArray(lm[id]) ? fitCircle(lm[id]) : null;
    const has = (...ids) => ids.every(P);

    const head = C('head'), sphere = C('sphere');

    // mm/px
    let mmpx = null, calNote = '';
    if (cal.mode === 'mmpx' && cal.value > 0) { mmpx = cal.value; calNote = '直接入力'; }
    else if (cal.mode === 'twoPoint' && cal.value > 0 && has('cal_a', 'cal_b')) {
      mmpx = cal.value / dist(P('cal_a'), P('cal_b')); calNote = '2点間';
    } else if (cal.mode === 'sphere' && cal.value > 0 && sphere) {
      mmpx = (cal.value / 2) / sphere.r; calNote = 'glenosphere 径';
    }
    const L = (px) => mmpx ? px * mmpx : px;
    const unit = mmpx ? 'mm' : 'px';

    const r = []; // { key, label, value, unit, ref, group }
    // hl：結果を選んだときに画像上で強調する図形 { segs, lines（延長線）, circles, poly, pts, ang:[頂点,a,b] }
    const push = (group, key, label, value, u, ref, hl) => r.push({ group, key, label, value, unit: u, ref: ref || '', hl: hl || null });
    const foot = (p, a, d) => add(a, mul(d, dot(sub(p, a), d))); // a を通る向き d の直線への垂線の足

    // ---- 向きの基準（外側・上方） ----
    const glc = has('gl_s', 'gl_i') ? mul(add(P('gl_s'), P('gl_i')), 0.5) : null;
    let ex = null, ey = null;
    if (has('sfl_m', 'sfl_l')) {
      ex = norm(sub(P('sfl_l'), P('sfl_m')));
      ey = { x: ex.y, y: -ex.x }; if (ey.y > 0) ey = mul(ey, -1);
    }
    // 外側の向き：SFL があればそれ、なければ 関節窩→大結節
    const latDir = ex || (glc && P('gt_l') ? norm(sub(P('gt_l'), glc)) : null);
    // 関節窩の局所座標：u = 下極→上極、n = u に垂直で外側向き
    let gu = null, gn = null;
    if (glc) {
      gu = norm(sub(P('gl_s'), P('gl_i')));
      gn = { x: gu.y, y: -gu.x };
      if (latDir && dot(gn, latDir) < 0) gn = mul(gn, -1);
    }

    // ---- 角度（肩甲骨・肩峰） ----
    if (has('gl_i', 'gl_s', 'acr_l')) push('角度', 'CSA', 'CSA（critical shoulder angle）', angleAt(P('gl_i'), P('gl_s'), P('acr_l')), '°', '正常 30〜35／>35 腱板断裂、<30 OA', { ang: [P('gl_i'), P('gl_s'), P('acr_l')] });
    // LSA・DSA（Boutsiadis 2018）：関節上結節・肩峰外側縁・大結節最外側の3点の三角形
    //   LSA = 肩峰外側縁を頂点（→関節上結節 と →大結節最外側）、DSA = 関節上結節を頂点（→肩峰外側縁 と →大結節最外側）
    if (has('gl_s', 'acr_l', 'gt_l')) {
      push('角度', 'LSA', 'LSA（lateralization）', angleAt(P('acr_l'), P('gl_s'), P('gt_l')), '°', 'RSA後 75〜95 で外旋良好', { ang: [P('acr_l'), P('gl_s'), P('gt_l')] });
      push('角度', 'DSA', 'DSA（distalization）', angleAt(P('gl_s'), P('acr_l'), P('gt_l')), '°', 'RSA後 40〜65 で挙上良好', { ang: [P('gl_s'), P('acr_l'), P('gt_l')] });
    }
    if (has('gl_s', 'gl_i', 'scap_inf')) push('角度', 'GPA', 'GPA（glenopolar angle）', angleAt(P('gl_s'), P('gl_i'), P('scap_inf')), '°', '正常 30〜45', { ang: [P('gl_s'), P('gl_i'), P('scap_inf')] });

    const acrLine = Array.isArray(lm.acr_under) ? fitLine(lm.acr_under) : null;
    // 置いた順に関係なく、肩峰下面の向きに沿って並べ替えて折れ線にする
    const acrPts = acrLine ? [...lm.acr_under].sort((a, b) => dot(sub(a, acrLine.c), acrLine.d) - dot(sub(b, acrLine.c), acrLine.d)) : null;
    if (acrLine && gu && latDir) {
      // LAA（Banas）：関節窩面と肩峰下面のなす角。肩峰が外側で下がるほど小さい
      let a = acrLine.d; if (dot(a, latDir) < 0) a = mul(a, -1);
      push('角度', 'LAA', 'LAA（lateral acromion angle）', 180 - deg(Math.atan2(Math.abs(cross(gu, a)), dot(gu, a))), '°', '正常 約80〜85／小さいと腱板断裂と関連',
        { lines: [[P('gl_s'), P('gl_i')], [acrPts[0], acrPts[acrPts.length - 1]]], poly: acrPts });
    }

    if (ex) {
      const loc = (v) => ({ x: dot(v, ex), y: dot(v, ey) }); // 向きだけ（原点不要）
      if (gu) {
        // β角：-X（内側向き）と 下極→上極 のなす角。90° が垂直、小さいほど上方傾斜
        const g = loc(sub(P('gl_s'), P('gl_i')));
        const beta = deg(Math.atan2(g.y, -g.x));
        const hlB = { lines: [[P('sfl_m'), P('sfl_l')], [P('gl_s'), P('gl_i')]] };
        push('角度', 'beta', 'β角（SFL と関節窩線）', beta, '°', '', hlB);
        push('角度', 'incl', '関節窩傾斜（90−β, 上向き+）', 90 - beta, '°', '', hlB);
      }
      if (has('gl_i', 'gl_il')) {
        // RSA角（Boileau）：下部関節窩線と SFL 垂線のなす角。上方傾斜を +
        const g = loc(sub(P('gl_il'), P('gl_i')));
        push('角度', 'RSAangle', 'RSA角（Boileau）', deg(Math.atan2(-g.x, g.y)), '°', '正常 約10（上方+）／術後 0 前後が目標',
          { lines: [[P('gl_i'), P('gl_il')], [P('gl_i'), add(P('gl_i'), ey)]], pts: [P('gl_i'), P('gl_il')] });
      }
    }

    // ---- 上腕骨（骨軸・骨頭軸） ----
    let shaft = null, headAxis = null;
    if (Array.isArray(lm.shaft) && lm.shaft.length >= 4) {
      const mids = [];
      for (let i = 0; i + 1 < lm.shaft.length; i += 2) mids.push(mul(add(lm.shaft[i], lm.shaft[i + 1]), 0.5));
      const f = fitLine(mids);
      if (f) {
        // dd：遠位向き（骨頭・大結節・関節窩から離れる向き）
        const prox = head ? head.c : (P('gt_l') || glc);
        let dd = f.d; if (prox && dot(dd, sub(prox, f.c)) > 0) dd = mul(dd, -1);
        // nl：骨軸に垂直で外側向き
        let nl = { x: dd.y, y: -dd.x };
        if (latDir ? dot(nl, latDir) < 0 : (P('gt_l') && dot(nl, sub(P('gt_l'), f.c)) < 0)) nl = mul(nl, -1);
        shaft = { ...f, mids, dd, nl, widths: [] };
        for (let i = 0; i + 1 < lm.shaft.length; i += 2) shaft.widths.push(dist(lm.shaft[i], lm.shaft[i + 1]));
      }
    }
    // 骨軸からの外側距離（外側が +）
    const latFromShaft = (p) => dot(sub(p, shaft.c), shaft.nl);

    if (has('neck_s', 'neck_i')) {
      const nm = mul(add(P('neck_s'), P('neck_i')), 0.5);
      const nd = norm(sub(P('neck_s'), P('neck_i')));
      let h = { x: nd.y, y: -nd.x }; // 解剖頚に垂直＝骨頭軸
      if (head ? dot(h, sub(head.c, nm)) < 0 : (shaft && dot(h, shaft.dd) > 0)) h = mul(h, -1);
      headAxis = { p: nm, h };
      push('上腕骨', 'neck_w', '解剖頚の幅', L(dist(P('neck_s'), P('neck_i'))), unit, '', { segs: [[P('neck_s'), P('neck_i')]] });
      if (head) {
        const hh = dot(sub(head.c, nm), h) + head.r;
        push('上腕骨', 'head_h', '骨頭の高さ（解剖頚から）', L(hh), unit, '正常 約15〜20mm', { segs: [[nm, add(nm, mul(h, hh))], [P('neck_s'), P('neck_i')]], circles: [head] });
      }
      if (shaft) {
        push('上腕骨', 'NSA', '頚体角（neck-shaft angle）', deg(Math.atan2(Math.abs(cross(h, shaft.dd)), dot(h, shaft.dd))), '°', '正常 130〜140',
          { lines: [[nm, add(nm, h)], [shaft.c, add(shaft.c, shaft.d)]] });
      }
    }
    if (shaft) {
      const pairs = []; for (let i = 0; i + 1 < lm.shaft.length; i += 2) pairs.push([lm.shaft[i], lm.shaft[i + 1]]);
      const axis = [shaft.c, add(shaft.c, shaft.d)];
      push('上腕骨', 'shaft_w', '骨幹の幅（平均）', L(shaft.widths.reduce((s, v) => s + v, 0) / shaft.widths.length), unit, '', { segs: pairs });
      if (shaft.mids.length >= 3) push('品質', 'shaft_rms', '骨軸 当てはめ誤差', L(shaft.rms), unit, '中点が一直線か', { lines: [axis], pts: shaft.mids });
      if (head) push('上腕骨', 'head_moff', '骨頭中心の内方オフセット（骨軸から）', L(-latFromShaft(head.c)), unit, '正常 約5〜9mm（内側+）',
        { lines: [axis], segs: [[head.c, foot(head.c, shaft.c, shaft.d)]], pts: [head.c] });
      if (P('gt_l')) push('上腕骨', 'gt_off', '大結節の外方オフセット（骨軸から）', L(latFromShaft(P('gt_l'))), unit, '',
        { lines: [axis], segs: [[P('gt_l'), foot(P('gt_l'), shaft.c, shaft.d)]] });
      if (head && P('gt_s')) {
        // HHH：骨頭頂部（骨軸方向で最も近位）が大結節頂部より何 mm 近位にあるか
        const top = sub(head.c, mul(shaft.dd, head.r)), hhh = dot(sub(P('gt_s'), top), shaft.dd), lvl = add(top, mul(shaft.dd, hhh));
        push('上腕骨', 'HHH', '骨頭頂部−大結節頂部の高さ（HHH）', L(hhh), unit, '骨軸方向、骨頭が高い +／大結節が上なら −',
          { circles: [head], segs: [[top, lvl], [lvl, P('gt_s')]], pts: [top, P('gt_s')] });
      }
    }
    if (head) push('上腕骨', 'head_d', '骨頭径', L(2 * head.r), unit, '', { circles: [head], segs: [[sub(head.c, { x: head.r, y: 0 }), add(head.c, { x: head.r, y: 0 })]] });

    // ---- 距離 ----
    if (acrLine && head) {
      const q = closestOnPolyline(head.c, acrPts), hp = add(head.c, mul(norm(sub(q, head.c)), head.r));
      push('距離', 'AHI', 'AHI（骨頭円−肩峰下面 最短）', L(dist(head.c, q) - head.r), unit, '正常 7〜14／<7 腱板断裂を疑う',
        { segs: [[hp, q]], circles: [head], poly: acrPts });
    }
    if (gn && P('acr_l') && P('gt_l')) {
      // 肩峰指数（Nyffeler）：関節窩面→肩峰外側端 ÷ 関節窩面→上腕骨外側
      const GA = Math.abs(dot(sub(P('acr_l'), glc), gn)), GH = Math.abs(dot(sub(P('gt_l'), glc), gn));
      push('距離', 'AI', '肩峰指数（acromion index）', GA / GH, '', '正常 約0.65／>0.73 腱板断裂と関連',
        { lines: [[P('gl_s'), P('gl_i')]], segs: [[P('acr_l'), foot(P('acr_l'), glc, gu)], [P('gt_l'), foot(P('gt_l'), glc, gu)]] });
    }
    if (has('acr_l', 'delt')) push('距離', 'acr_delt', '肩峰外側端−三角筋粗面', L(dist(P('acr_l'), P('delt'))), unit, '腕の長さの指標（術前後で比較）', { segs: [[P('acr_l'), P('delt')]] });

    // ---- 座標系 ----
    let frame = null, altFrame = null, pillar = null;
    if (ex) {
      // 旧形式（上点・下点の2点）も読めるようにしておく
      const pts = Array.isArray(lm.pillar) ? lm.pillar : (has('pil_s', 'pil_i') ? [P('pil_s'), P('pil_i')] : null);
      pillar = fitLine(pts);
      if (pillar) {
        frame = makeFrame(P('sfl_m'), P('sfl_l'), pillar.p1, pillar.p2);
        if (frame) {
          const mk = (c, d) => makeFrame(P('sfl_m'), P('sfl_l'), c, add(c, d));
          // ピラー線の角度が 1° ずれたときの原点移動
          const f1 = mk(pillar.c, rotate(pillar.d, Math.PI / 180));
          if (f1) pillar.sens1deg = dist(f1.o, frame.o);
          // 1点抜き（leave-one-out）で原点がどれだけ動くか
          if (pts.length >= 3) {
            pillar.loo = Math.max(...pts.map((_, i) => {
              const f = fitLine(pts.filter((__, j) => j !== i));
              const fr = f && mk(f.c, f.d);
              return fr ? dist(fr.o, frame.o) : 0;
            }));
          }
          // 置いた点が SFL から何 px 下にあるか（帯の再現性の記録）
          const ys = pts.map((p) => -frame.toLocal(p).y);
          pillar.yMin = Math.min(...ys); pillar.yMax = Math.max(...ys);
          pillar.n = pts.length; pillar.pts = pts;
        }
      } else pillar = null;
      if (glc) altFrame = makeFrame(P('sfl_m'), P('sfl_l'), P('gl_s'), P('gl_i'));
    }

    // ---- 本来の関節窩（基準症例＝術前など）をこの画像へ写す ----
    // ref: { glS, glI, headC?, acrDelt? }（SFL×ピラー座標の mm）。両画像とも較正済みが条件
    let refGl = null, refHead = null;
    if (opts.ref && frame && mmpx) {
      const toImg = (q) => frame.toImage({ x: q.x / mmpx, y: q.y / mmpx });
      refGl = { s: toImg(opts.ref.glS), i: toImg(opts.ref.glI) };
      if (opts.ref.headC) refHead = toImg(opts.ref.headC);
    }

    // ---- 回転中心 ----
    const centers = [];
    if (head) centers.push({ key: 'head', label: '骨頭中心', c: head.c, r: head.r, rms: head.rms });
    if (sphere) centers.push({ key: 'sphere', label: 'Glenosphere 中心', c: sphere.c, r: sphere.r, rms: sphere.rms });

    // 関節窩（中心・面）に対する位置：外側＝面に垂直、上方＝面に沿って
    const glOffset = (c, s, i) => {
      const m = mul(add(s, i), 0.5), u = norm(sub(s, i));
      let n = { x: u.y, y: -u.x }; if (latDir && dot(n, latDir) < 0) n = mul(n, -1);
      return { lat: dot(sub(c, m), n), sup: dot(sub(c, m), u) };
    };

    for (const ce of centers) {
      const g = '回転中心：' + ce.label;
      const cc = { c: ce.c, r: ce.r };
      push(g, ce.key + '_r', '半径', L(ce.r), unit, '当てはめ誤差 ' + L(ce.rms).toFixed(1) + unit, { circles: [cc], pts: [ce.c] });
      // ---- 外方化・下方化（原点＝この回転中心）----
      // 肩甲骨側：X＝SFL、Y＝SFL の垂線。肩峰外側端の位置で、外側 −・上方 +（三角筋の起始）
      // 上腕骨側：Y＝骨軸、X＝骨軸の垂線。外方化＝骨軸の x（外側 +）、下方化＝大結節頂部（下方 +）
      // どちらも「大きいほど外方化・下方化」なので、足し算で global になる
      let sLat = null, sDist = null, hLat = null, hDist = null;
      if (ex && P('acr_l')) {
        const d = sub(P('acr_l'), ce.c), fx = add(ce.c, mul(ex, dot(d, ex)));
        sLat = -dot(d, ex); sDist = dot(d, ey);
        const hl = { lines: [[P('sfl_m'), P('sfl_l')]], segs: [[ce.c, fx], [fx, P('acr_l')]], pts: [ce.c, P('acr_l')] };
        push(g, ce.key + '_slat', '肩甲骨側 外方化（肩峰外側端の x）', L(sLat), unit, 'SFL 方向、外側 −', { ...hl, segs: [hl.segs[0]] });
        push(g, ce.key + '_sdist', '肩甲骨側 下方化（肩峰外側端の y）', L(sDist), unit, 'SFL の垂線方向、上方 +', { ...hl, segs: [hl.segs[1]] });
      }
      if (shaft) {
        const ft = foot(ce.c, shaft.c, shaft.d);
        hLat = -latFromShaft(ce.c);
        push(g, ce.key + '_hlat', '上腕骨側 外方化（骨軸の x）', L(hLat), unit, '骨軸に垂直、外側 +',
          { lines: [[shaft.c, add(shaft.c, shaft.d)]], segs: [[ce.c, ft]], pts: [ce.c] });
        if (P('gt_s')) {
          const d = sub(P('gt_s'), ce.c), fy = add(ce.c, mul(shaft.dd, dot(d, shaft.dd)));
          hDist = dot(d, shaft.dd);
          push(g, ce.key + '_hdist', '上腕骨側 下方化（大結節頂部の y）', L(hDist), unit, '骨軸方向、下方 +',
            { lines: [[shaft.c, add(shaft.c, shaft.d)]], segs: [[ce.c, fy], [fy, P('gt_s')]], pts: [ce.c, P('gt_s')] });
        }
      }
      if (sLat != null && hLat != null) push(g, ce.key + '_glat_g', 'Global 外方化（肩甲骨側＋上腕骨側）', L(sLat + hLat), unit, '0＝骨軸が肩峰外側端の真下',
        { lines: [[shaft.c, add(shaft.c, shaft.d)], [P('sfl_m'), P('sfl_l')]], pts: [ce.c, P('acr_l')] });
      if (sDist != null && hDist != null) push(g, ce.key + '_gdist_g', 'Global 下方化（肩甲骨側＋上腕骨側）', L(sDist + hDist), unit, '肩峰外側端から大結節頂部まで',
        { lines: [[shaft.c, add(shaft.c, shaft.d)], [P('sfl_m'), P('sfl_l')]], pts: [ce.c, P('acr_l'), P('gt_s')] });

      // 座標系 f の原点から X 方向、続いて Y 方向に折れ線で示す
      const xyHl = (f, l) => ({ segs: [[f.o, f.toImage({ x: l.x, y: 0 })], [f.toImage({ x: l.x, y: 0 }), ce.c]], pts: [f.o, ce.c] });
      if (frame) {
        const l = frame.toLocal(ce.c), h = xyHl(frame, l);
        push(g, ce.key + '_x', 'X（外側+）', L(l.x), unit, 'SFL×ピラー 原点', { ...h, segs: [h.segs[0]], lines: [[P('sfl_m'), P('sfl_l')]] });
        push(g, ce.key + '_y', 'Y（頭側+）', L(l.y), unit, 'SFL×ピラー 原点', { ...h, segs: [h.segs[1]], lines: [[P('sfl_m'), P('sfl_l')]] });
      }
      // 関節窩線 s-i に対して：中心 m → 面に沿った位置 → 回転中心
      const glHl = (s, i) => { const m = mul(add(s, i), 0.5), u = norm(sub(s, i)), f = foot(ce.c, m, u);
        return { lines: [[s, i]], segs: [[m, f], [f, ce.c]], pts: [m, ce.c] }; };
      if (glc) {
        const o = glOffset(ce.c, P('gl_s'), P('gl_i')), h = glHl(P('gl_s'), P('gl_i'));
        push(g, ce.key + '_glat', '関節窩面からの外方オフセット', L(o.lat), unit, 'この画像の関節窩線（中心から面に垂直）', { ...h, segs: [h.segs[1]] });
        push(g, ce.key + '_gsup', '関節窩中心からの上方位置', L(o.sup), unit, '面に沿って、下方は −', { ...h, segs: [h.segs[0]] });
      }
      if (refGl) {
        const o = glOffset(ce.c, refGl.s, refGl.i), h = glHl(refGl.s, refGl.i);
        push(g, ce.key + '_nlat', '本来の関節窩面からの外方オフセット', L(o.lat), unit, '基準症例の関節窩を写したもの', { ...h, segs: [h.segs[1]] });
        push(g, ce.key + '_nsup', '本来の関節窩中心からの上方位置', L(o.sup), unit, '下方は −', { ...h, segs: [h.segs[0]] });
      }
      if (refHead) {
        const d = frame.toLocal(ce.c), d0 = frame.toLocal(refHead), hl = { segs: [[refHead, ce.c]], pts: [refHead, ce.c] };
        push(g, ce.key + '_dx', '基準の骨頭中心からの移動 X', L(d.x - d0.x), unit, '外側化 +', hl);
        push(g, ce.key + '_dy', '基準の骨頭中心からの移動 Y', L(d.y - d0.y), unit, '下方化 −', hl);
      }
      if (shaft) push(g, ce.key + '_shaft', '上腕骨軸からの距離', L(-latFromShaft(ce.c)), unit, '内側 +（骨軸に垂直）',
        { lines: [[shaft.c, add(shaft.c, shaft.d)]], segs: [[ce.c, foot(ce.c, shaft.c, shaft.d)]], pts: [ce.c] });
      if (headAxis) push(g, ce.key + '_haxis', '骨頭軸からの距離', L(Math.abs(cross(headAxis.h, sub(ce.c, headAxis.p)))), unit, '解剖頚の垂線からの垂直距離',
        { lines: [[headAxis.p, add(headAxis.p, headAxis.h)]], segs: [[ce.c, foot(ce.c, headAxis.p, headAxis.h)]], pts: [ce.c] });
      if (P('gt_l')) {
        push(g, ce.key + '_gt', '大結節外側面までの距離', L(dist(ce.c, P('gt_l'))), unit, '直線距離', { segs: [[ce.c, P('gt_l')]], pts: [ce.c, P('gt_l')] });
        const dirH = shaft ? shaft.nl : latDir;
        if (dirH) {
          const e = add(ce.c, mul(dirH, dot(sub(P('gt_l'), ce.c), dirH)));
          push(g, ce.key + '_gth', '大結節外側面までの水平距離', L(dot(sub(P('gt_l'), ce.c), dirH)), unit, shaft ? '骨軸に垂直（三角筋レバーアームの目安）' : 'SFL 方向',
            { segs: [[ce.c, e], [e, P('gt_l')]], pts: [ce.c, P('gt_l')] });
        }
      }
      if (acrLine) push(g, ce.key + '_acr', '肩峰下面までの最短距離', L(distToPolyline(ce.c, acrPts)), unit, '肩峰下面の輪郭まで',
        { segs: [[ce.c, closestOnPolyline(ce.c, acrPts)]], poly: acrPts, pts: [ce.c] });
      if (altFrame) {
        const l = altFrame.toLocal(ce.c), h = xyHl(altFrame, l);
        push('比較', ce.key + '_ax', ce.label + ' X′', L(l.x), unit, 'SFL×関節窩線 原点', { ...h, segs: [h.segs[0]] });
        push('比較', ce.key + '_ay', ce.label + ' Y′', L(l.y), unit, 'SFL×関節窩線 原点', { ...h, segs: [h.segs[1]] });
      }
    }
    if (sphere && gu) {
      // glenosphere の下方張り出し：関節窩下極より sphere の下端がどれだけ下か（関節窩線方向）
      const bottom = sub(sphere.c, mul(gu, sphere.r));
      push('回転中心：Glenosphere 中心', 'sphere_ovh', '下方張り出し（overhang）', L(dot(sub(P('gl_i'), bottom), gu)), unit, '関節窩下極基準、+ が張り出し（ノッチング予防）',
        { circles: [sphere], lines: [[P('gl_s'), P('gl_i')]], pts: [P('gl_i'), bottom] });
    }
    if (head && sphere) push('比較', 'cor_shift', '骨頭中心→sphere中心 移動量', L(dist(head.c, sphere.c)), unit, '同一画像内に両方ある場合', { segs: [[head.c, sphere.c]], circles: [head, sphere] });
    if (opts.ref && opts.ref.acrDelt && has('acr_l', 'delt') && mmpx) {
      push('距離', 'arm_len', '腕の延長（基準症例との差）', L(dist(P('acr_l'), P('delt'))) - opts.ref.acrDelt, unit, '肩峰外側端−三角筋粗面の差', { segs: [[P('acr_l'), P('delt')]] });
    }

    if (ex && shaft) {
      // 2つの座標系のずれ：0° なら global の和は画像上の実距離と一致する
      const a = deg(Math.atan2(Math.abs(cross(shaft.dd, mul(ey, -1))), dot(shaft.dd, mul(ey, -1))));
      push('品質', 'frame_tilt', '上腕骨軸と SFL 垂線のなす角', a, '°', 'global は座標系ごとの和（腕の位置に左右されない）。0° のときだけ画像上の実距離と一致',
        { lines: [[shaft.c, add(shaft.c, shaft.d)], [P('sfl_m'), P('sfl_l')]] });
    }
    if (frame) {
      const hlP = { lines: [[P('sfl_m'), P('sfl_l')], [pillar.p1, pillar.p2]], pts: [frame.o, ...pillar.pts] };
      push('品質', 'cross', 'SFL×ピラー 交差角', frame.crossAngle, '°', frame.crossAngle < 25 ? '⚠ 浅い：原点が不安定' : '', hlP);
      push('品質', 'pil_n', 'ピラー点数', pillar.n, '点', pillar.n < 4 ? '4 点以上を推奨' : '', hlP);
      if (pillar.n >= 3) push('品質', 'pil_rms', 'ピラー当てはめ誤差', L(pillar.rms), unit, '大きい＝縁が曲がっている／点がばらついている', hlP);
      if (pillar.sens1deg != null) push('品質', 'pil_sens', '原点移動（ピラー角 1°あたり）', L(pillar.sens1deg), unit, '', hlP);
      if (pillar.loo != null) push('品質', 'pil_loo', '原点移動（1点抜き 最大）', L(pillar.loo), unit, mmpx && L(pillar.loo) > 2 ? '⚠ 2mm超：点を見直す' : '', hlP);
      push('品質', 'pil_from', 'ピラー区間 上端（SFLから下へ）', L(pillar.yMin), unit, '', hlP);
      push('品質', 'pil_to', 'ピラー区間 下端（SFLから下へ）', L(pillar.yMax), unit, '', hlP);
    }

    const order = ['角度', '距離', '上腕骨', '回転中心：骨頭中心', '回転中心：Glenosphere 中心', '比較', '品質'];
    r.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    // 基準症例として使うときの値（この画像の SFL×ピラー座標、mm）
    let asRef = null;
    if (frame && mmpx && glc) {
      const m = (p) => { const l = frame.toLocal(p); return { x: l.x * mmpx, y: l.y * mmpx }; };
      asRef = { glS: m(P('gl_s')), glI: m(P('gl_i')), headC: head ? m(head.c) : null,
        acrDelt: has('acr_l', 'delt') ? dist(P('acr_l'), P('delt')) * mmpx : null };
    }
    return { results: r, ex, ey, frame, altFrame, pillar, head, sphere, shaft, headAxis, acrLine, acrPts, refGl, refHead, asRef, mmpx, calNote, unit };
  }

  global.XG = { LANDMARKS, compute, fitCircle, fitLine, distToPolyline, intersect, angleAt, makeFrame, dist };
})(window);
