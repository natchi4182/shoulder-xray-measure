// ランドマークの半自動検出（段階A：画像処理のみ、学習データ不要）。
// 結果は「候補」。点の配列を返すだけで、計算は geometry.js がこれまで通り行う。
// 画像は { w, h, d: Float32Array(輝度 0〜1) }。座標は元画像の px。
(function (global) {
  'use strict';

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const len = (a) => Math.hypot(a.x, a.y);
  const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
  const perp = (a) => ({ x: -a.y, y: a.x });

  // ---- 輝度画像（長辺 MAXD px に縮小して処理し、座標は元に戻す） ----
  const MAXD = 1600;
  const cache = new WeakMap();
  function grayOf(canvas) {
    if (canvas.d && canvas.w) return { k: 1, ...canvas }; // 輝度画像を直接渡したとき（検証用）
    if (cache.has(canvas)) return cache.get(canvas);
    const k = Math.min(1, MAXD / Math.max(canvas.width, canvas.height));
    const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data, d = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
    const im = { w, h, d, k };
    cache.set(canvas, im);
    return im;
  }

  // 双線形補間で輝度を読む（範囲外は NaN）
  function at(im, x, y) {
    if (x < 0 || y < 0 || x > im.w - 1 || y > im.h - 1) return NaN;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, im.w - 1), y1 = Math.min(y0 + 1, im.h - 1);
    const fx = x - x0, fy = y - y0, d = im.d, w = im.w;
    return (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) + (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy;
  }

  // p から方向 u に t0〜t1 の輝度プロファイル（1px 刻み、平滑化済み）
  function profile(im, p, u, t0, t1) {
    const n = Math.max(0, Math.floor(t1 - t0)) + 1, raw = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = at(im, p.x + u.x * (t0 + i), p.y + u.y * (t0 + i)); raw[i] = v; }
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0, wsum = 0;
      for (let j = -2; j <= 2; j++) {
        const v = raw[i + j]; if (v === undefined || Number.isNaN(v)) continue;
        const wt = 3 - Math.abs(j); a += v * wt; wsum += wt;
      }
      s[i] = wsum ? a / wsum : NaN;
    }
    return s;
  }
  // 中心差分の微分（2px 幅）
  function deriv(s) {
    const d = new Float32Array(s.length);
    for (let i = 2; i < s.length - 2; i++) d[i] = (s[i + 2] - s[i - 2]) / 4;
    return d;
  }

  // ---- 直線・円の当てはめ ----
  function fitLine(pts) {
    const n = pts.length; if (n < 2) return null;
    const c = { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const x = p.x - c.x, y = p.y - c.y; sxx += x * x; sxy += x * y; syy += y * y; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), d = { x: Math.cos(th), y: Math.sin(th) }, nn = perp(d);
    const rms = Math.sqrt(pts.reduce((s, p) => s + dot(sub(p, c), nn) ** 2, 0) / n);
    return { c, d, n: nn, rms };
  }
  function circle3(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { c: { x, y }, r: Math.hypot(a.x - x, a.y - y) };
  }
  function fitCircleLS(pts) {
    const n = pts.length; if (n < 3) return null;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
    let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (const p of pts) {
      const u = p.x - mx, v = p.y - my;
      suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    const det = suu * svv - suv * suv; if (Math.abs(det) < 1e-9) return null;
    const r1 = (suuu + suvv) / 2, r2 = (svvv + svuu) / 2;
    const uc = (r1 * svv - r2 * suv) / det, vc = (r2 * suu - r1 * suv) / det;
    return { c: { x: uc + mx, y: vc + my }, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
  }
  // 再現性のある乱数（同じ画像・同じタップなら同じ結果にする）
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  // ---- 円（骨頭・glenosphere） ----
  // seed：中心付近のタップ。放射状に縁の候補を集め、RANSAC で円を選ぶ。
  // 骨頭は「内側が明るく外側が暗い」縁。glenosphere（metal）は輝度差が大きい。反転画像にも対応するため両極性を試す。
  function detectCircle(canvas, seedImg, opts = {}) {
    const im = grayOf(canvas), k = im.k, D = Math.max(im.w, im.h);
    const seed = mul(seedImg, k);
    const rMin = (opts.rMin ? opts.rMin * k : 0.02 * D), rMax = (opts.rMax ? opts.rMax * k : 0.2 * D);
    const NR = 120;
    let best = null;
    for (const pol of [1, -1]) {
      // 各レイで、外向きに輝度が下がる（pol=1）縁の候補を強い順に最大4つ
      const cands = [];
      for (let i = 0; i < NR; i++) {
        const th = (i / NR) * Math.PI * 2, u = { x: Math.cos(th), y: Math.sin(th) };
        const s = profile(im, seed, u, 0, rMax + 3), d = deriv(s);
        let mx = 0; const loc = [];
        for (let j = Math.ceil(rMin); j < d.length - 2; j++) {
          const v = -pol * d[j];
          if (v > 0 && v >= -pol * d[j - 1] && v >= -pol * d[j + 1]) { loc.push({ j, v }); if (v > mx) mx = v; }
        }
        loc.sort((a, b) => b.v - a.v);
        for (const c of loc.slice(0, 4)) if (c.v > 0.3 * mx) cands.push({ ray: i, p: add(seed, mul(u, c.j)), v: c.v });
      }
      if (cands.length < 6) continue;
      const vmax = cands.reduce((m, c) => Math.max(m, c.v), 0);
      const R = rng(Math.round(seed.x * 73856093) ^ Math.round(seed.y * 19349663) ^ (pol > 0 ? 7 : 11));
      for (let it = 0; it < 600; it++) {
        const a = cands[(R() * cands.length) | 0], b = cands[(R() * cands.length) | 0], c = cands[(R() * cands.length) | 0];
        if (a.ray === b.ray || b.ray === c.ray || a.ray === c.ray) continue;
        const cc = circle3(a.p, b.p, c.p);
        if (!cc || cc.r < rMin || cc.r > rMax) continue;
        if (len(sub(cc.c, seed)) > 0.6 * cc.r) continue; // タップは中心付近という前提
        const tol = 1.5 + 0.02 * cc.r;
        const byRay = new Map();
        for (const q of cands) {
          const e = Math.abs(len(sub(q.p, cc.c)) - cc.r);
          if (e < tol) { const o = byRay.get(q.ray); if (!o || q.v > o.v) byRay.set(q.ray, q); }
        }
        const score = [...byRay.values()].reduce((s, q) => s + 0.5 + 0.5 * q.v / vmax, 0);
        if (!best || score > best.score) best = { score, cc, inl: [...byRay.values()], pol };
      }
    }
    if (!best || best.inl.length < 8) return null;
    // 最小二乗で整え、もう一度近い候補だけで当てはめ直す
    let fit = fitCircleLS(best.inl.map((q) => q.p));
    if (!fit) return null;
    const tol2 = 1.5 + 0.02 * fit.r;
    const inl = best.inl.filter((q) => Math.abs(len(sub(q.p, fit.c)) - fit.r) < tol2);
    fit = fitCircleLS(inl.map((q) => q.p)) || fit;
    // 縁がとれた角度の広がり（骨頭は関節窩と重なるので全周はとれない）
    const angs = inl.map((q) => Math.atan2(q.p.y - fit.c.y, q.p.x - fit.c.x)).sort((a, b) => a - b);
    let gap = 0; for (let i = 0; i < angs.length; i++) gap = Math.max(gap, ((angs[(i + 1) % angs.length] - angs[i]) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI);
    const coverage = 1 - gap / (2 * Math.PI) ;
    const rms = Math.sqrt(inl.reduce((s, q) => s + (len(sub(q.p, fit.c)) - fit.r) ** 2, 0) / inl.length);
    const frac = inl.length / NR;
    const conf = frac >= 0.45 && coverage >= 0.5 && rms < 0.015 * fit.r + 1 ? 'high' : 'low';
    // 保存する点：角度順に 12 点前後へ間引く（手で直しやすい数）
    inl.sort((a, b) => Math.atan2(a.p.y - fit.c.y, a.p.x - fit.c.x) - Math.atan2(b.p.y - fit.c.y, b.p.x - fit.c.x));
    const step = Math.max(1, Math.floor(inl.length / 12));
    const pts = inl.filter((_, i) => i % step === 0).map((q) => mul(q.p, 1 / k));
    return { pts, c: mul(fit.c, 1 / k), r: fit.r / k, conf, frac, coverage, rms: rms / k, polarity: best.pol };
  }

  // ---- 外側縁の追跡（ピラー線） ----
  // seed：外側縁の上のタップ。lateral：外側の向き（SFL があればその外向き）。なければ縁の極性から決める。
  // band：{ inBand(pImg) } 帯の中だけ点を置く（較正済み・SFL ありのとき）
  function tracePillar(canvas, seedImg, opts = {}) {
    const im = grayOf(canvas), k = im.k, D = Math.max(im.w, im.h);
    let s0 = mul(seedImg, k);
    // タップ周辺の勾配の向き（構造テンソル）で縁の向きを決める
    const rw = Math.max(4, Math.round(0.012 * D));
    let jxx = 0, jxy = 0, jyy = 0, gx0 = 0, gy0 = 0;
    for (let dy = -rw; dy <= rw; dy++) for (let dx = -rw; dx <= rw; dx++) {
      const x = s0.x + dx, y = s0.y + dy;
      const gx = (at(im, x + 1, y) - at(im, x - 1, y)) / 2, gy = (at(im, x, y + 1) - at(im, x, y - 1)) / 2;
      if (Number.isNaN(gx) || Number.isNaN(gy)) continue;
      const wt = Math.exp(-(dx * dx + dy * dy) / (2 * (rw / 2) ** 2));
      jxx += wt * gx * gx; jxy += wt * gx * gy; jyy += wt * gy * gy; gx0 += wt * gx; gy0 += wt * gy;
    }
    const th = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
    let nrm = { x: Math.cos(th), y: Math.sin(th) }; // 縁に垂直
    // 外側の向き：外側へ行くと暗くなる（勾配は内側＝骨を向く）
    if (opts.lateral) { if (dot(nrm, opts.lateral) < 0) nrm = mul(nrm, -1); }
    else if (nrm.x * gx0 + nrm.y * gy0 > 0) nrm = mul(nrm, -1);
    // 垂線方向に探して、外側へ暗くなる最も強い縁
    const w1 = Math.max(4, 0.015 * D), w2 = Math.max(3, 0.006 * D), h = Math.max(3, 0.006 * D);
    const findEdge = (p, n, w) => {
      const s = profile(im, p, n, -w, w), d = deriv(s);
      let bj = -1, bv = 0;
      for (let j = 2; j < d.length - 2; j++) if (-d[j] > bv) { bv = -d[j]; bj = j; }
      return bj < 0 ? null : { p: add(p, mul(n, bj - w)), v: bv };
    };
    const e0 = findEdge(s0, nrm, w1);
    if (!e0 || e0.v < 0.004) return null;
    s0 = e0.p;
    const maxSide = Math.round((opts.maxLen ? opts.maxLen * k : 0.12 * D) / h);
    const track = [{ p: s0, v: e0.v }];
    for (const sgn of [1, -1]) {
      let p = s0, t = mul(perp(nrm), sgn), n = nrm, miss = 0;
      const side = [];
      for (let i = 0; i < maxSide && miss < 3; i++) {
        const q = add(p, mul(t, h));
        const e = findEdge(q, n, w2);
        if (!e || e.v < 0.35 * e0.v) { miss++; p = q; continue; }
        miss = 0; side.push({ p: e.p, v: e.v }); p = e.p;
        // 直近の点で向きを更新（急に曲がらないよう、直前の向きと混ぜる）
        const recent = [s0, ...side.map((s) => s.p)].slice(-6);
        if (recent.length >= 3) {
          const f = fitLine(recent); let nt = f.d; if (dot(nt, t) < 0) nt = mul(nt, -1);
          t = norm(add(mul(t, 0.6), mul(nt, 0.4))); n = perp(t); if (dot(n, nrm) < 0) n = mul(n, -1);
        }
      }
      if (sgn > 0) track.push(...side); else track.unshift(...side.reverse());
    }
    let use = track.map((q) => ({ p: mul(q.p, 1 / k), v: q.v }));
    let bandNote = '';
    if (opts.inBand) {
      const inb = use.filter((q) => opts.inBand(q.p));
      if (inb.length >= 3) use = inb; else bandNote = '帯の中で縁を追えなかったため、帯の外も使っています';
    }
    if (use.length < 3) return null;
    // 弧長で等間隔に 5 点
    const arc = [0]; for (let i = 1; i < use.length; i++) arc.push(arc[i - 1] + len(sub(use[i].p, use[i - 1].p)));
    const N = Math.min(5, use.length), pts = [];
    for (let i = 0; i < N; i++) {
      const target = arc[arc.length - 1] * i / (N - 1);
      let j = 0; while (j < arc.length - 1 && arc[j] < target) j++;
      pts.push(use[j].p);
    }
    const f = fitLine(use.map((q) => q.p));
    const lenPx = arc[arc.length - 1];
    const conf = use.length >= 6 && f.rms < 0.004 * D / k + 1 && lenPx > 0.04 * D / k && !bandNote ? 'high' : 'low';
    return { pts, trace: use.map((q) => q.p), conf, rms: f.rms, length: lenPx, note: bandNote };
  }

  // ---- 上腕骨骨幹（骨軸） ----
  // seed：骨幹の中ほどのタップ。dir：近位→遠位のおおよその向き（骨頭中心→タップ）。なければタップ周辺の縁の向き。
  // halfMax：骨幹の半幅の上限（元画像 px）。avoid：{ c, r } 骨頭の円（その近くの高さは使わない）
  // implant：術後（ステムあり）。ステムの縁ではなく皮質の外縁を取る
  function detectShaft(canvas, seedImg, opts = {}) {
    const im = grayOf(canvas), k = im.k, D = Math.max(im.w, im.h);
    const seed = mul(seedImg, k);
    let u;
    if (opts.dir && len(opts.dir) > 0) u = norm(opts.dir);
    else {
      // 縁の向き（構造テンソル）：勾配が骨幹の幅方向を向くので、その垂直が骨軸
      const rw = Math.max(6, Math.round(0.03 * D));
      let jxx = 0, jxy = 0, jyy = 0;
      for (let dy = -rw; dy <= rw; dy += 2) for (let dx = -rw; dx <= rw; dx += 2) {
        const x = seed.x + dx, y = seed.y + dy;
        const gx = (at(im, x + 1, y) - at(im, x - 1, y)) / 2, gy = (at(im, x, y + 1) - at(im, x, y - 1)) / 2;
        if (Number.isNaN(gx) || Number.isNaN(gy)) continue;
        jxx += gx * gx; jxy += gx * gy; jyy += gy * gy;
      }
      const th = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
      u = perp({ x: Math.cos(th), y: Math.sin(th) });
    }
    const W = Math.max(8, opts.halfMax ? opts.halfMax * k : 0.08 * D);
    const avoid = opts.avoid ? { c: mul(opts.avoid.c, k), r: opts.avoid.r * k } : null;
    // 高さ p で骨幹を横切る：外側から骨へ明るくなる縁と、骨から外へ暗くなる縁（皮質の外縁）
    // implant：ステムが髄腔にあると最も強い縁はステムの縁になる。画像でいちばん明るい帯（金属）を見つけ、その外側で皮質の外縁を探す
    const gap = Math.max(2, Math.round(0.003 * D));
    let hi = Infinity, metalLevels = 0;
    if (opts.implant) {
      const hist = new Uint32Array(256); for (let i = 0; i < im.d.length; i++) hist[Math.min(255, Math.floor(im.d[i] * 256))]++;
      let acc = 0, t = 255; for (; t > 0; t--) { acc += hist[t]; if (acc > 0.01 * im.d.length) break; }
      hi = 0.9 * t / 256;
    }
    const cross = (p, n) => {
      const s = profile(im, p, n, -W, W), d = deriv(s), m = Math.round(W);
      // 範囲内で最も強い縁。peak のときは勾配の山だけ（金属の縁のすそ野を拾わない）
      const best = (sg, i0, i1, peak) => {
        let bi = -1, bv = 0;
        for (let i = Math.max(2, i0); i < Math.min(d.length - 2, i1); i++) {
          const v = sg * d[i];
          if (v > bv && (!peak || (v >= sg * d[i - 1] && v >= sg * d[i + 1]))) { bv = v; bi = i; }
        }
        return [bi, bv];
      };
      const rise = (i0, i1, peak) => best(1, i0, i1, peak), fall = (j0, j1, peak) => best(-1, j0, j1, peak);
      let lo = m, up = m, metal = false;
      if (opts.implant) {
        // 中心に最も近い金属の連続区間
        // 金属の区間をすべてつなぐ（スクリューホール・骨移植用の穴で途切れても、ステムの両端までを1本とみなす）
        let run = null;
        for (let i = 0; i < s.length;) {
          if (!(s[i] >= hi)) { i++; continue; }
          let j = i; while (j + 1 < s.length && s[j + 1] >= hi) j++;
          if (j - i >= 2 && i > gap && j < s.length - 1 - gap) run = run ? { i: run.i, j } : { i, j };
          i = j + 1;
        }
        const dc = run ? (m < run.i ? run.i - m : m > run.j ? m - run.j : 0) : Infinity;
        if (dc < 0.3 * W) { lo = run.i - gap; up = run.j + gap; metal = true; }
      }
      let [bi, bv] = rise(2, lo, metal), [bj, bw] = fall(up, d.length, metal);
      if (metal) {
        // 金属の外に骨の縁（金属の縁の 2 割以上の強さ）がなければ、金属ではなく骨そのものだった
        const [, mv] = rise(lo - gap, lo + 2 * gap), [, mw] = fall(up - 2 * gap, up + gap);
        if (bi < 0 || bj < 0 || bv < 0.2 * mv || bw < 0.2 * mw) {
          metal = false;
          [bi, bv] = rise(2, m); [bj, bw] = fall(m, d.length);
        }
      }
      if (bi < 0 || bj < 0) return null;
      if (metal) metalLevels++;
      return { a: add(p, mul(n, bi - W)), b: add(p, mul(n, bj - W)), v: Math.min(bv, bw), w: bj - bi };
    };
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    let c = seed, kept = [];
    const NL = 15; // 骨軸に沿って調べる高さの数
    for (let it = 0; it < 4; it++) {
      metalLevels = 0;
      const n = perp(u), Ls = 2.5 * W, hs = [];
      for (let i = 0; i < NL; i++) {
        const p = add(c, mul(u, -Ls + 2 * Ls * i / (NL - 1)));
        if (avoid && len(sub(p, avoid.c)) < avoid.r * 1.6) continue;
        const e = cross(p, n); if (e) hs.push(e);
      }
      if (hs.length < 3) return null;
      const mw = median(hs.map((e) => e.w)), mv = median(hs.map((e) => e.v));
      kept = hs.filter((e) => Math.abs(e.w - mw) < 0.25 * mw && e.v > 0.35 * mv && e.v > 0.004);
      if (kept.length < 3) return null;
      let f = fitLine(kept.map((e) => mul(add(e.a, e.b), 0.5)));
      // 中点が骨軸から外れた高さ（穴や重なりで縁を取り違えた）を除いて当てはめ直す
      const res = kept.map((e) => Math.abs(dot(sub(mul(add(e.a, e.b), 0.5), f.c), f.n)));
      const tol = Math.max(1.5, 3 * median(res), 0.05 * mw);
      const inl = kept.filter((e, i) => res[i] <= tol);
      if (inl.length >= 3 && inl.length < kept.length) { kept = inl; f = fitLine(kept.map((e) => mul(add(e.a, e.b), 0.5))); }
      let nu = f.d; if (dot(nu, u) < 0) nu = mul(nu, -1);
      u = nu; c = add(f.c, mul(u, dot(sub(seed, f.c), u))); // 中心はタップの高さの骨軸上
    }
    const mids = kept.map((e) => mul(add(e.a, e.b), 0.5)), f = fitLine(mids);
    const ws = kept.map((e) => e.w), mw = ws.reduce((s, x) => s + x, 0) / ws.length;
    const cv = Math.sqrt(ws.reduce((s, x) => s + (x - mw) ** 2, 0) / ws.length) / mw;
    // 等間隔に 4 組（端と中）
    const N = Math.min(4, kept.length), pts = [];
    for (let i = 0; i < N; i++) { const e = kept[Math.round(i * (kept.length - 1) / (N - 1))]; pts.push(mul(e.a, 1 / k), mul(e.b, 1 / k)); }
    const conf = kept.length >= 9 && f.rms < 0.004 * D && cv < 0.12 ? 'high' : 'low';
    const note = metalLevels >= 3 ? 'ステムの縁ではなく、その外側の皮質外縁で骨軸を取りました' : '';
    return { pts, trace: mids.map((q) => mul(q, 1 / k)), conf, rms: f.rms / k, n: kept.length, cv, metalLevels, note };
  }

  // ---- SFL（棘上窩底）の補正 ----
  // 2点のタップの間で、棘上窩底の明るい線（稜線）を探して直線を当てはめ、2点をその線上へ寄せる。
  function refineSFL(canvas, aImg, bImg) {
    const im = grayOf(canvas), k = im.k, D = Math.max(im.w, im.h);
    const a = mul(aImg, k), b = mul(bImg, k), ab = sub(b, a), L = len(ab);
    if (L < 0.03 * D) return null;
    const u = norm(ab), n = perp(u), w = Math.min(Math.max(4, 0.02 * D), 0.2 * L);
    const cands = [];
    for (let i = 0; i <= 14; i++) {
      const p = add(a, mul(ab, i / 14));
      const s = profile(im, p, n, -w, w);
      let bj = -1, bv = 0;
      for (let j = 3; j < s.length - 3; j++) {
        const r = -(s[j - 3] - 2 * s[j] + s[j + 3]); // 明るい線ほど大きい
        if (r > bv && s[j] >= s[j - 1] && s[j] >= s[j + 1]) { bv = r; bj = j; }
      }
      if (bj >= 0 && bv > 0.003) cands.push({ p: add(p, mul(n, bj - w)), v: bv, t: i / 14 });
    }
    if (cands.length < 6) return null;
    // RANSAC 直線
    const R = rng(Math.round(a.x * 31 + a.y * 17 + b.x * 13 + b.y * 7));
    const tol = Math.max(1.5, 0.004 * D);
    let best = null;
    for (let it = 0; it < 300; it++) {
      const p = cands[(R() * cands.length) | 0], q = cands[(R() * cands.length) | 0];
      if (p === q) continue;
      const nn = perp(norm(sub(q.p, p.p)));
      const inl = cands.filter((c) => Math.abs(dot(sub(c.p, p.p), nn)) < tol);
      const sc = inl.reduce((s, c) => s + c.v, 0);
      if (!best || sc > best.sc) best = { sc, inl };
    }
    if (!best || best.inl.length < 6) return null;
    const f = fitLine(best.inl.map((c) => c.p));
    const proj = (p) => add(f.c, mul(f.d, dot(sub(p, f.c), f.d)));
    const na = proj(a), nb = proj(b);
    // タップから大きく離れる補正は採らない
    if (len(sub(na, a)) > w || len(sub(nb, b)) > w) return null;
    const ang = Math.acos(Math.min(1, Math.abs(dot(f.d, u)))) * 180 / Math.PI;
    const conf = best.inl.length >= 10 && f.rms < tol && ang < 8 ? 'high' : 'low';
    return { a: mul(na, 1 / k), b: mul(nb, 1 / k), trace: best.inl.map((c) => mul(c.p, 1 / k)), conf, angle: ang, n: best.inl.length };
  }


  // ---- 台形補正用：X線の範囲（フィルム／モニター表示部）の四隅 ----
  // 長辺 512px に縮小 → 勾配 → 勾配方向つきハフ変換で直線を拾い、横向き2本・縦向き2本の組み合わせのうち
  // 4辺に沿って縁がよく続く四角形を選ぶ。モニターの枠を拾っても同じ平面なので台形補正の向きは正しい
  const quadCache = new WeakMap();
  function quadLines(canvas) {
    if (quadCache.has(canvas)) return quadCache.get(canvas);
    const QM = 512, k = Math.min(1, QM / Math.max(canvas.width, canvas.height));
    const w = Math.max(8, Math.round(canvas.width * k)), h = Math.max(8, Math.round(canvas.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    let d = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = (px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) / 255;
    // 3×3 平均を2回（モアレ・ノイズを抑える）
    for (let pass = 0; pass < 2; pass++) {
      const o = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += d[yy * w + xx]; n++; } }
        o[y * w + x] = s / n;
      }
      d = o;
    }
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = d[i - w - 1], b = d[i - w], cc = d[i - w + 1], l = d[i - 1], r = d[i + 1], e = d[i + w - 1], f = d[i + w], q = d[i + w + 1];
      gx[i] = (cc + 2 * r + q) - (a + 2 * l + e); gy[i] = (e + 2 * f + q) - (a + 2 * b + cc);
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
    // 上位 12% の勾配だけ投票
    const sorted = Float32Array.from(mag).sort();
    const thr = Math.max(0.05, sorted[Math.floor(sorted.length * 0.88)]);
    const R = Math.ceil(Math.hypot(w, h)), NR = 2 * R + 1, NT = 180;
    const acc = new Float32Array(NT * NR);
    const cs = [], sn = [];
    for (let t = 0; t < NT; t++) { cs.push(Math.cos(t * Math.PI / 180)); sn.push(Math.sin(t * Math.PI / 180)); }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i]; if (m < thr) continue;
      let t0 = Math.round(Math.atan2(gy[i], gx[i]) * 180 / Math.PI); t0 = ((t0 % 180) + 180) % 180;
      for (let dt = -3; dt <= 3; dt++) {
        const t = (t0 + dt + 180) % 180, rho = Math.round(x * cs[t] + y * sn[t]);
        acc[t * NR + rho + R] += m;
      }
    }
    // 山を拾う：強い順に並べ、すでに採った線と θ±4°・ρ±10px 以内のものは捨てる
    let maxV = 0; for (let i = 0; i < acc.length; i++) if (acc[i] > maxV) maxV = acc[i];
    const vmin = Math.max(thr * 20, maxV * 0.05), cand = [];
    for (let i = 0; i < acc.length; i++) if (acc[i] >= vmin) cand.push(i);
    cand.sort((a, b) => acc[b] - acc[a]);
    const peaks = [];
    for (const i of cand) {
      const t = Math.floor(i / NR), rho = (i % NR) - R;
      const dup = peaks.some((p) => {
        let dt = Math.abs(p.t - t), dr = Math.abs(p.rho - rho);
        if (dt > 90) { dt = 180 - dt; dr = Math.abs(p.rho + rho); } // θ が 0°/180° をまたぐときは ρ の符号が反転
        return dt <= 4 && dr <= 10;
      });
      if (!dup) peaks.push({ t, rho, v: acc[i] });
      if (peaks.length >= 40) break;
    }
    const lines = peaks.slice(0, 40).map((p) => ({ c: cs[p.t], s: sn[p.t], rho: p.rho, t: p.t, v: p.v }));
    const res = { k, w, h, gx, gy, mag, thr, lines };
    quadCache.set(canvas, res);
    return res;
  }
  function meet(L1, L2) {
    const det = L1.c * L2.s - L1.s * L2.c; if (Math.abs(det) < 1e-6) return null;
    return { x: (L1.rho * L2.s - L2.rho * L1.s) / det, y: (L1.c * L2.rho - L2.c * L1.rho) / det };
  }
  // 辺 a→b に沿って、辺に直交する向きの強い勾配が続いている割合（0〜1）
  function edgeSupport(Q, a, b) {
    const L = Math.hypot(b.x - a.x, b.y - a.y); if (L < 10) return 0;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }, nrm = { x: -u.y, y: u.x };
    let hit = 0, n = 0;
    for (let s = L * 0.06; s <= L * 0.94; s += 2) {
      const cx = a.x + u.x * s, cy = a.y + u.y * s;
      if (cx < 1 || cy < 1 || cx > Q.w - 2 || cy > Q.h - 2) continue; // 写真の外にはみ出た部分は数えない
      n++;
      for (let o = -2; o <= 2; o++) {
        const x = Math.round(cx + nrm.x * o), y = Math.round(cy + nrm.y * o), i = y * Q.w + x, m = Q.mag[i];
        if (m > Q.thr * 0.6 && Math.abs(Q.gx[i] * nrm.x + Q.gy[i] * nrm.y) > 0.85 * m) { hit++; break; }
      }
    }
    return n >= 10 ? hit / n : 0;
  }
  function detectQuad(canvas) {
    const Q = quadLines(canvas), { w, h, k } = Q;
    const hor = [], ver = [];
    for (const L of Q.lines) {
      if (Math.abs(L.t - 90) < 35) hor.push({ ...L, pos: (L.rho - (w / 2) * L.c) / L.s });
      else if (L.t < 35 || L.t > 145) ver.push({ ...L, pos: (L.rho - (h / 2) * L.s) / L.c });
    }
    const H = hor.slice(0, 12), V = ver.slice(0, 12);
    let best = null;
    for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) {
      const [top, bot] = H[i].pos < H[j].pos ? [H[i], H[j]] : [H[j], H[i]];
      if (bot.pos - top.pos < h * 0.2) continue;
      for (let m = 0; m < V.length; m++) for (let n = m + 1; n < V.length; n++) {
        const [lef, rig] = V[m].pos < V[n].pos ? [V[m], V[n]] : [V[n], V[m]];
        if (rig.pos - lef.pos < w * 0.2) continue;
        const q = [meet(top, lef), meet(top, rig), meet(bot, rig), meet(bot, lef)];
        if (q.some((p) => !p || p.x < -w * 0.15 || p.x > w * 1.15 || p.y < -h * 0.15 || p.y > h * 1.15)) continue;
        // 各角が 55〜125°（つぶれた四角形を除く）
        let ok = true;
        for (let a = 0; a < 4 && ok; a++) {
          const p = q[a], p0 = q[(a + 3) % 4], p1 = q[(a + 1) % 4];
          const v1 = norm(sub(p0, p)), v2 = norm(sub(p1, p)), ang = Math.acos(Math.max(-1, Math.min(1, dot(v1, v2)))) * 180 / Math.PI;
          if (ang < 55 || ang > 125) ok = false;
        }
        if (!ok) continue;
        let area = 0; for (let a = 0; a < 4; a++) { const p = q[a], r = q[(a + 1) % 4]; area += p.x * r.y - r.x * p.y; }
        const ar = Math.abs(area) / 2 / (w * h);
        if (ar < 0.12) continue;
        const sup = [0, 1, 2, 3].map((a) => edgeSupport(Q, q[a], q[(a + 1) % 4]));
        const mn = Math.min(...sup), mean = sup.reduce((x, y) => x + y, 0) / 4;
        const score = (0.5 * mean + 0.5 * mn) * (0.7 + 0.3 * Math.sqrt(Math.min(1, ar)));
        if (!best || score > best.score) best = { q, score, mean, mn, ar };
      }
    }
    if (!best || best.mn < 0.25 || best.mean < 0.45) return null;
    return { pts: best.q.map((p) => mul(p, 1 / k)), score: best.score, support: best.mean };
  }
  // 手でタップした角を、近くの「角らしい」直線の交点に吸着させる（無ければ null）
  // 角らしい＝交点から2本の線それぞれの片側に縁が続いている（L字）
  function snapCorner(canvas, p, radius) {
    const Q = quadLines(canvas), k = Q.k, pk = mul(p, k), rad = radius * k;
    const L = Q.lines.slice(0, 30), arm = Math.max(16, Math.min(Q.w, Q.h) * 0.08);
    const armSupport = (x, L1) => {
      const u = { x: -L1.s, y: L1.c }; // 線の向き
      return Math.max(edgeSupport(Q, add(x, mul(u, 3)), add(x, mul(u, arm))), edgeSupport(Q, sub(x, mul(u, 3)), sub(x, mul(u, arm))));
    };
    let best = null, bs = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      let dt = Math.abs(L[i].t - L[j].t); dt = Math.min(dt, 180 - dt);
      if (dt < 50) continue;
      const x = meet(L[i], L[j]); if (!x) continue;
      const dd = Math.hypot(x.x - pk.x, x.y - pk.y); if (dd > rad) continue;
      const a1 = armSupport(x, L[i]), a2 = armSupport(x, L[j]);
      if (a1 < 0.6 || a2 < 0.6) continue;
      const sc = Math.min(a1, a2) * (1 - 0.5 * dd / rad);
      if (sc > bs) { bs = sc; best = x; }
    }
    return best ? mul(best, 1 / k) : null;
  }

  // 斜めから撮った長方形の本当の縦横比（幅/高さ）。4隅から焦点距離を推定して求める
  // （Zhang & He, Whiteboard scanning, 2006）。主点は写真の中心とみなす。
  // q = [左上, 右上, 右下, 左下]、W・H は写真の大きさ。求まらないとき（ほぼ正面など）は null
  function rectAspect(q, W, H) {
    const u0 = W / 2, v0 = H / 2;
    const m1 = [q[0].x, q[0].y, 1], m2 = [q[1].x, q[1].y, 1], m3 = [q[3].x, q[3].y, 1], m4 = [q[2].x, q[2].y, 1];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const c14 = cross(m1, m4);
    const k2 = dt(c14, m3) / dt(cross(m2, m4), m3), k3 = dt(c14, m2) / dt(cross(m3, m4), m2);
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    const zz = n2[2] * n3[2];
    const scale = Math.max(W, H);
    // 消失点の一方が無限遠（上下だけ・左右だけ傾けた）だと焦点距離が決まらない。
    // そのときはスマホ標準カメラの焦点距離（長辺の約 0.75 倍、35mm 換算 26mm 相当）を仮定する
    let f2 = Math.abs(zz) > 1e-9 ? -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + zz * u0 * u0) +
                 (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + zz * v0 * v0)) / zz : NaN;
    const nzRel = Math.min(Math.abs(n2[2]) * scale / Math.hypot(n2[0], n2[1]), Math.abs(n3[2]) * scale / Math.hypot(n3[0], n3[1]));
    if (!(f2 > 0) || nzRel < 0.02 || Math.sqrt(f2) < scale * 0.4 || Math.sqrt(f2) > scale * 6) f2 = (scale * 0.75) ** 2;
    const qf = (n) => { // n^T (K^-T K^-1) n
      const x = n[0] - u0 * n[2], y = n[1] - v0 * n[2];
      return (x * x + y * y) / f2 + n[2] * n[2];
    };
    const r = Math.sqrt(qf(n2) / qf(n3));
    return r > 0.2 && r < 5 ? r : null;
  }

  // ---- 人工関節（金属）の有無と種類 ----
  // 金属は画像でいちばん明るく、中が平ら（ほぼ飽和）で厚みがあり、縁で輝度が段差状に落ちる。
  // 骨の重なりは輝度がばらつき、縁もなだらか。長辺 400px 程度に縮めて、上位 0.5% 輝度×0.9 以上の塊を調べる。
  // 種類：丸い塊（glenosphere）と細長い塊（ステム）が別々 → RSA、1つにつながる → TSA/HHR。
  // sphere とカップが接して1つに見えるときは、少しずつ削って分かれるかを見る（広く重なっていると分かれず TSA と出る）
  function detectImplant(canvas) {
    const G = grayOf(canvas), st = Math.max(1, Math.round(Math.max(G.w, G.h) / 400));
    const w = Math.floor(G.w / st), h = Math.floor(G.h / st), N = w * h;
    const d = new Float32Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let j = 0; j < st; j++) for (let i = 0; i < st; i++) s += G.d[(y * st + j) * G.w + x * st + i];
      d[y * w + x] = s / (st * st);
    }
    const hist = new Uint32Array(256); for (let i = 0; i < N; i++) hist[Math.min(255, Math.floor(d[i] * 256))]++;
    const top = (p) => { let a = 0; for (let t = 255; t > 0; t--) { a += hist[t]; if (a > p * N) return t / 256; } return 0; };
    const none = { implant: false, kind: null, conf: 'high', parts: [] };
    const tHi = top(0.005);
    if (tHi < 0.35) return none;
    const thr = 0.9 * tHi;
    let m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = d[i] >= thr ? 1 : 0;
    const erode = (a) => {
      const o = new Uint8Array(N);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; o[i] = a[i] & a[i - 1] & a[i + 1] & a[i - w] & a[i + w]; }
      return o;
    };
    const R = 3; // 縁の段差を測る距離（縮小後 px）
    // 塊ごとに 面積・輪郭・縁の段差・中の輝度のそろい方・細長さ
    const blobs = (e) => {
      const lab = new Int32Array(N), stack = [], out = [];
      for (let s0 = 0; s0 < N; s0++) {
        if (!e[s0] || lab[s0]) continue;
        const id = out.length + 1, P = { area: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, bnd: 0, edge: 0, nEdge: 0, border: 0, vals: [] };
        lab[s0] = id; stack.push(s0);
        while (stack.length) {
          const i = stack.pop(), x = i % w, y = (i / w) | 0;
          P.area++; P.sx += x; P.sy += y; P.sxx += x * x; P.syy += y * y; P.sxy += x * y; P.vals.push(d[i]);
          if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) P.border++;
          let isB = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            if (!e[yy * w + xx]) {
              isB = true;
              const xo = x + dx * R, yo = y + dy * R;
              if (xo >= 0 && yo >= 0 && xo < w && yo < h) { P.edge += d[i] - d[yo * w + xo]; P.nEdge++; }
            }
          }
          if (isB) P.bnd++;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx; if (e[j] && !lab[j]) { lab[j] = id; stack.push(j); }
          }
        }
        const mx = P.sx / P.area, my = P.sy / P.area;
        const cxx = P.sxx / P.area - mx * mx, cyy = P.syy / P.area - my * my, cxy = P.sxy / P.area - mx * my;
        const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const vs = P.vals.sort((a, b) => a - b), med = vs[vs.length >> 1];
        let flat = 0; for (const v of vs) if (Math.abs(v - med) <= 0.035) flat++;
        out.push({
          c: { x: mx * st / G.k, y: my * st / G.k }, area: P.area / N, thick: P.bnd ? P.area / P.bnd : 0,
          step: P.nEdge ? P.edge / P.nEdge : 0, flat: flat / vs.length, border: P.bnd ? P.border / P.bnd : 1,
          elong: Math.sqrt((tr / 2 + disc) / Math.max(1e-6, tr / 2 - disc)),
        });
      }
      return out;
    };
    m = erode(m); // 1px 削って細い皮質線を消す
    const metal = blobs(m).filter((p) => p.area >= 0.0015 && p.thick >= 2.5 && p.step >= 0.24 && p.flat >= 0.8 && p.border < 0.3)
      .sort((a, b) => b.area - a.area);
    if (!metal.length) return none;
    const big = metal.filter((p) => p.area >= 0.25 * metal[0].area);
    // 丸い塊と細長い塊が別々に出るまで削る（最大 3px）
    let round = big.filter((p) => p.elong < 2), long = big.filter((p) => p.elong >= 2);
    for (let k = 0; k < 3 && !(round.length && long.length); k++) {
      m = erode(m);
      const bs = blobs(m).filter((p) => p.area >= 0.15 * metal[0].area);
      const r2 = bs.filter((p) => p.elong < 2), l2 = bs.filter((p) => p.elong >= 2);
      if (r2.length && l2.length) { round = r2; long = l2; }
    }
    let kind, conf = 'low';
    if (round.length && long.length) { kind = 'RSA'; conf = 'high'; }
    else if (round.length >= 2) kind = 'RSA';
    else kind = 'TSA'; // 骨頭とステムが1つにつながっている（sphere とカップが広く重なった RSA もここに入るので確からしさは低）
    return { implant: true, kind, conf, parts: big };
  }

  global.XA = { detectCircle, tracePillar, detectShaft, refineSFL, detectQuad, snapCorner, rectAspect, detectImplant, _grayOf: grayOf };
})(typeof window !== 'undefined' ? window : globalThis);
