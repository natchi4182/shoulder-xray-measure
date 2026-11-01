// 目視分類の見本：自作の模式図（正面像、外側＝右）と定義文。
// 実際のX線画像は著作権があるため使わず、ユーザー自身の保存症例を見本として併せて表示する。
(function (global) {
  'use strict';

  const BONE = '#cfd6dc', EDGE = '#8b98a5', BG = '#0d1117', IMP = '#9fb3c8', POLY = '#e8d9a8';

  // ---- 部品 ----
  // 関節窩面：上端 x=top、下端 x=bot、bow はくぼみの深さ
  function scapula({ top = 82, bot = 82, bow = 8, gTop = 76, gBot = 142 } = {}) {
    const mx = (top + bot) / 2 - bow, my = (gTop + gBot) / 2;
    return `<path d="M0,58 L58,62 Q70,64 ${top},${gTop} Q${mx},${my} ${bot},${gBot} L48,200 L0,200 Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
  }
  // 肩峰：下面の y（骨頭の上あたり）と臼蓋化（下面が骨頭に沿って凹む）
  function acromion({ y = 52, acetab = false, cx = 128 } = {}) {
    const under = acetab ? `Q${cx},${y - 16} 58,${y - 2}` : `Q${cx},${y + 1} 58,${y - 2}`;
    return `<path d="M50,${y - 16} L172,${y - 10} L172,${y + 2} ${under} Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
  }
  // 上腕骨：骨幹＋大結節＋骨頭。collapse(0〜1) で骨頭上部が潰れる
  function humerus({ cx = 128, cy = 108, r = 36, collapse = 0, gt = true } = {}) {
    let s = `<path d="M${cx - 26},${cy + 22} Q${cx - 16},${cy + 50} ${cx - 16},200 L${cx + 22},200 Q${cx + 22},${cy + 44} ${cx + 36},${cy + 10} Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    if (gt) s += `<ellipse cx="${cx + 30}" cy="${cy - 4}" rx="13" ry="19" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    if (!collapse) s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    else {
      const y0 = cy - r * (1 - 0.55 * collapse), w = Math.sqrt(r * r - (y0 - cy) ** 2);
      const zz = [0.2, 0.4, 0.6, 0.8].map((t, i) => `L${cx - w + 2 * w * t},${y0 + (i % 2 ? 3 : -2)}`).join(' ');
      s += `<path d="M${cx - w},${y0} ${zz} L${cx + w},${y0} A${r},${r} 0 1 1 ${cx - w},${y0} Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
      s += `<path d="M${cx - w + 4},${y0 + 4} L${cx + w - 4},${y0 + 4}" stroke="#fff" stroke-width="2" opacity=".6"/>`; // 硬化
    }
    return s;
  }
  // 下方骨棘（Samilson）：骨頭の内下方と関節窩下縁から下へ伸びる
  function osteophytes(len, cx = 128, cy = 108, r = 36) {
    if (!len) return '';
    const a = 125 * Math.PI / 180, px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
    return `<path d="M${px + 6},${py - 2} L${px - 3},${py + len} L${px - 6},${py - 4} Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.2"/>` +
      `<path d="M84,140 L${84 - 2},${142 + len * 0.8} L77,140 Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.2"/>`;
  }
  const svg = (inner) => `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="200" fill="${BG}"/>${inner}</svg>`;
  const arrow = (x1, y1, x2, y2) => `<path d="M${x1},${y1} L${x2},${y2}" stroke="#ffd23f" stroke-width="1.5" marker-end="url(#ah)"/>`;
  const defs = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffd23f"/></marker></defs>`;
  const note = (x, y, t) => `<text x="${x}" y="${y}" fill="#ffd23f" font-size="10" font-family="system-ui">${t}</text>`;

  // ---- RSA（Sirveaux のノッチング用） ----
  function rsa(grade) {
    // 肩甲骨頚部下縁のノッチ（欠損）を grade に応じて広げる
    const notch = [null,
      'M80,138 Q74,146 82,150 Z',
      'M81,136 Q62,144 70,156 L82,150 Z',
      'M82,134 Q46,140 52,166 L82,150 Z',
      'M84,112 Q40,124 46,170 L84,150 Z'][grade];
    let s = scapula({ top: 84, bot: 84, bow: 0 });
    if (notch) s += `<path d="${notch}" fill="${BG}" stroke="#ff6b6b" stroke-width="1.2" stroke-dasharray="3 2"/>`;
    // スクリュー・中心ペグ・ベースプレート・glenosphere
    s += `<path d="M84,92 L58,72" stroke="${IMP}" stroke-width="4"/><path d="M84,130 L60,158" stroke="${IMP}" stroke-width="4"/>`;
    s += `<rect x="60" y="106" width="26" height="8" fill="${IMP}"/>`;
    s += `<rect x="84" y="84" width="6" height="52" fill="${IMP}"/>`;
    s += `<path d="M90,82 A28,28 0 0 1 90,138 Z" fill="${IMP}" stroke="#dfe7ef" stroke-width="1"/>`;
    // 上腕骨コンポーネント（ポリエチレン＋ステム）
    s += `<path d="M124,88 Q112,110 124,132 L132,132 Q120,110 132,88 Z" fill="${POLY}"/>`;
    s += `<path d="M130,86 L156,92 L154,140 Q148,170 144,200 L120,200 Q122,160 128,134 Q120,110 130,86 Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    s += `<path d="M138,120 L134,200" stroke="${IMP}" stroke-width="7"/>`;
    s += acromion({ y: 50, cx: 120 });
    return s;
  }

  // ---- Neer（正面像での骨片の転位） ----
  function neer(parts) {
    const d = { shaft: parts >= 2, gt: parts >= 3, lt: parts >= 4, head: parts >= 4 };
    let s = scapula() + acromion({ y: 50 });
    const sx = d.shaft ? -14 : 0, sy = d.shaft ? -6 : 0;
    // 骨幹（外科頚より遠位）
    s += `<path d="M${104 + sx},${128 + sy} L${150 + sx},${128 + sy} Q${148 + sx},165 ${146 + sx},200 L${112 + sx},200 Q${110 + sx},165 ${104 + sx},${128 + sy} Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    // 大結節
    const gx = d.gt ? 14 : 0, gy = d.gt ? -18 : 0;
    s += `<ellipse cx="${158 + gx}" cy="${104 + gy}" rx="12" ry="20" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    // 骨頭（4-part では内反・回旋して孤立）
    const hx = d.head ? -4 : 0, hy = d.head ? 10 : 0;
    s += `<g transform="rotate(${d.head ? 35 : 0} ${126 + hx} ${108 + hy})"><path d="M${96 + hx},${118 + hy} A33,33 0 1 1 ${152 + hx},${122 + hy} Q${126 + hx},${142 + hy} ${96 + hx},${118 + hy} Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/></g>`;
    // 小結節（正面像では骨頭に重なる小さな骨片）
    const lx = d.lt ? -16 : 0, ly = d.lt ? 8 : 0;
    s += `<ellipse cx="${110 + lx}" cy="${120 + ly}" rx="7" ry="9" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5" stroke-dasharray="${d.lt ? '' : '2 2'}"/>`;
    // 骨折線
    s += `<path d="M100,${130} L154,${130}" stroke="#ff6b6b" stroke-width="1.2" stroke-dasharray="3 2"/>`;
    s += `<path d="M146,86 L148,${126}" stroke="#ff6b6b" stroke-width="1.2" stroke-dasharray="3 2"/>`;
    return s;
  }

  // ---- Levy（RSA 後の肩峰・肩甲棘の疲労骨折）：骨折線の位置。鎖骨は肩鎖関節の目印 ----
  function levy(type) {
    let s = rsa(0) + `<path d="M0,22 L96,26 L98,36 L0,34 Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>` + note(4, 18, '鎖骨');
    const x = { I: 152, II: 104, III: 64 }[type];
    if (x) s += `<path d="M${x},28 L${x + 4},40 L${x - 2},46 L${x + 6},56" stroke="#ff6b6b" stroke-width="3" fill="none"/>` + arrow(x + 20, 76, x + 6, 58);
    return s;
  }

  // ---- Lazarus（関節窩コンポーネントの透亮線）：3本ペグ。full＝全周、part＝一部 ----
  function lazarus({ full = [], part = [], loose = false } = {}) {
    let s = scapula({ top: 86, bot: 86, bow: 0 }) + humerus({ cx: 136, cy: 110, r: 34, gt: true }) + acromion({ y: 52, cx: 136 });
    s += `<path d="M138,78 A32,32 0 0 0 138,142 L132,142 L132,78 Z" fill="${IMP}"/>`; // 骨頭コンポーネント
    s += `<g transform="${loose ? 'rotate(-14 86 110) translate(4,8)' : ''}">`;
    [92, 110, 128].forEach((y, i) => {
      if (full.includes(i)) s += `<rect x="54" y="${y - 6}" width="34" height="12" rx="3" fill="${BG}" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="2 2"/>`;
      if (part.includes(i)) s += `<path d="M56,${y - 5} L88,${y - 5}" stroke="#ff6b6b" stroke-width="2.5"/>`;
      s += `<rect x="58" y="${y - 3}" width="28" height="6" fill="${POLY}"/>`;
    });
    s += `<path d="M86,78 Q100,110 86,142 L92,142 Q106,110 92,78 Z" fill="${POLY}" stroke="#bfae7a"/></g>`;
    return s;
  }

  // ---- Stress shielding（非セメントステム周囲の骨吸収） ----
  function shield(grade) {
    let s = scapula({ top: 86, bot: 86, bow: 0 }) + acromion({ y: 50, cx: 134 });
    // 頚部の骨切り線（108,122）−（152,88）の上に人工骨頭、下に骨幹と大結節
    s += `<path d="M108,122 Q104,160 110,200 L150,200 Q150,160 158,116 L152,88 Z" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    s += `<ellipse cx="162" cy="98" rx="11" ry="17" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5"/>`;
    s += `<path d="M126,110 L140,104 L136,190 L130,190 Z" fill="${IMP}"/>`; // ステム
    s += `<path d="M108,122 A28,28 0 0 1 152,88 Z" fill="${IMP}" stroke="#dfe7ef" stroke-width="1"/>`;
    const hole = (d) => `<path d="${d}" fill="${BG}" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="2 2"/>`;
    if (grade >= 1) s += hole('M162,86 Q172,98 164,112 Q155,100 162,86 Z'); // 大結節
    if (grade >= 2) s += hole('M109,126 Q118,140 112,156 Q105,140 109,126 Z'); // 内側 calcar
    if (grade >= 3) s += hole('M157,118 Q156,140 152,160 Q149,140 152,120 Z') + hole('M107,158 Q112,176 110,192 Q104,176 107,158 Z'); // 骨幹皮質
    return s;
  }

  // ---- Gärtner（石灰沈着の形） ----
  function gartner(type) {
    let s = `<defs><filter id="gblur"><feGaussianBlur stdDeviation="${type === 'III' ? 4 : 1.6}"/></filter></defs>`;
    s += scapula() + humerus() + acromion();
    const c = 'cx="150" cy="70" rx="15" ry="8"';
    if (type === 'I') s += `<ellipse ${c} fill="#ffffff" stroke="#ffffff" stroke-width="1.5"/>`;
    if (type === 'II') s += `<ellipse ${c} fill="#ffffff" opacity=".85" filter="url(#gblur)"/>`;
    if (type === 'III') s += `<ellipse cx="150" cy="70" rx="18" ry="10" fill="#ffffff" opacity=".45" filter="url(#gblur)"/>`;
    return s + note(124, 22, '石灰沈着');
  }

  // ---- 軸位像（Walch 用）：上＝前方、下＝後方、右＝外側 ----
  // ant/post：関節窩の前縁・後縁、ridge：二重凹面の稜（なければ単一凹面）、bow：くぼみの深さ
  function axial({ ant = [82, 62], post = [82, 138], ridge = null, bow = 8, head = [122, 100], r = 34, sclerosis = false, osteo = false } = {}) {
    const [ax, ay] = ant, [px, py] = post;
    const face = ridge
      ? `Q${(ax + ridge[0]) / 2 - 5},${(ay + ridge[1]) / 2} ${ridge[0]},${ridge[1]} Q${(ridge[0] + px) / 2 - 10},${(ridge[1] + py) / 2} ${px},${py}`
      : `Q${(ax + px) / 2 - bow},${(ay + py) / 2} ${px},${py}`;
    // 骨頭を先に描き、関節窩の輪郭（侵食の形）が隠れないようにする
    let s = `<circle cx="${head[0]}" cy="${head[1]}" r="${r}" fill="${BONE}" stroke="${EDGE}" stroke-width="1.5" opacity=".85"/>`;
    s += `<path d="M8,96 L34,95 Q58,88 ${ax},${ay} ${face} Q58,112 34,105 L8,104 Z" fill="${BONE}" stroke="#5c6b78" stroke-width="2"/>`;
    // 肩甲骨軸（Friedman 線）とその垂線＝後捻 0° の基準
    s += `<path d="M0,100 L200,100" stroke="#3fd0ff" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>`;
    s += `<path d="M84,44 L84,156" stroke="#3fd0ff" stroke-width="1" stroke-dasharray="2 3" opacity=".7"/>`;
    if (sclerosis) s += `<path d="M${(ax + px) / 2 - bow / 2},${(ay + py) / 2 + 4} Q${px - 4},${py - 14} ${px},${py}" stroke="#fff" stroke-width="3" fill="none" opacity=".7"/>`;
    if (osteo) s += `<path d="M${px},${py} L${px + 10},${py + 8} L${px - 2},${py + 4} Z" fill="${BONE}" stroke="${EDGE}"/>`;
    s += `<text x="186" y="16" fill="#8b949e" font-size="11" font-family="system-ui">前</text><text x="186" y="194" fill="#8b949e" font-size="11" font-family="system-ui">後</text>`;
    return s;
  }

  // ---- 分類の定義（模式図・説明） ----
  const C = {
    hamada: {
      title: 'Hamada 分類（腱板断裂の X 線病期）',
      note: 'Hamada 1990。Grade 4 は Walch らが 4a/4b に細分',
      grades: [
        ['1', 'AHI 6 mm 以上。骨頭の上方化なし', () => scapula() + humerus({ cy: 108 }) + acromion({ y: 52 })],
        ['2', 'AHI 5 mm 以下。骨頭が上方化', () => scapula() + humerus({ cy: 92 }) + acromion({ y: 52 }) + note(150, 62, 'AHI↓')],
        ['3', 'Grade 2 ＋ 肩峰下面の臼蓋化（骨頭に沿って凹む）', () => scapula() + humerus({ cy: 84 }) + acromion({ y: 50, acetab: true }) + note(148, 30, '臼蓋化')],
        ['4a', '肩甲上腕関節の狭小化。臼蓋化なし', () => scapula({ top: 80, bot: 80 }) + humerus({ cx: 116, cy: 92 }) + acromion({ y: 52 }) + arrow(70, 166, 82, 112) + note(40, 178, '関節裂隙↓')],
        ['4b', '関節の狭小化 ＋ 肩峰の臼蓋化', () => scapula({ top: 80, bot: 80 }) + humerus({ cx: 116, cy: 84 }) + acromion({ y: 50, acetab: true, cx: 116 })],
        ['5', '上腕骨頭の圧潰（cuff tear arthropathy）', () => scapula({ top: 78, bot: 80 }) + humerus({ cx: 118, cy: 88, collapse: 0.9 }) + acromion({ y: 50, acetab: true, cx: 118 }) + note(140, 128, '圧潰')],
      ],
    },
    samilson: {
      title: 'Samilson-Prieto 分類（OA の重症度）',
      note: '骨頭・関節窩の下方骨棘の大きさで判定',
      grades: [
        ['0', '正常', () => scapula() + humerus() + acromion()],
        ['1', '下方骨棘 3 mm 未満', () => scapula() + humerus() + acromion() + osteophytes(5)],
        ['2', '下方骨棘 3〜7 mm、関節面の軽度不整', () => scapula() + humerus() + acromion() + osteophytes(11)],
        ['3', '下方骨棘 7 mm 超、関節裂隙の狭小化・骨硬化', () => scapula({ top: 80, bot: 80 }) + humerus({ cx: 118 }) + acromion() + osteophytes(20, 118) + `<path d="M80,78 Q72,109 80,142" stroke="#fff" stroke-width="3" fill="none" opacity=".7"/>`],
      ],
    },
    favard: {
      title: 'Favard 分類（CTA の関節窩侵食）',
      note: 'Sirveaux・Favard 2004。E4 は下方優位の侵食として後に追加',
      grades: [
        ['E0', '骨頭は上方化するが関節窩の侵食なし', () => scapula() + humerus({ cy: 90 }) + acromion({ y: 50 })],
        ['E1', '関節窩の同心性の侵食（面全体が内側へ）', () => scapula({ top: 72, bot: 72 }) + humerus({ cx: 118, cy: 96 }) + acromion({ y: 50, cx: 118 }) + arrow(92, 110, 76, 110)],
        ['E2', '関節窩上部の侵食（上方が斜めに削れる）', () => scapula({ top: 64, bot: 82, bow: 3, gTop: 68 }) + humerus({ cx: 112, cy: 84 }) + acromion({ y: 48, cx: 112 }) + arrow(86, 80, 70, 76)],
        ['E3', '上方の侵食が関節窩下部まで及ぶ', () => scapula({ top: 58, bot: 74, bow: 2, gTop: 66 }) + humerus({ cx: 106, cy: 86 }) + acromion({ y: 48, cx: 106 }) + arrow(84, 120, 70, 118)],
        ['E4', '下方優位の侵食', () => scapula({ top: 82, bot: 66, bow: 3 }) + humerus({ cx: 116, cy: 116 }) + acromion({ y: 52 }) + arrow(88, 136, 72, 136)],
      ],
    },
    sirveaux: {
      title: 'Sirveaux 分類（RSA 後の scapular notching）',
      note: '肩甲骨頚部下縁の骨欠損の範囲で判定（赤い破線部）',
      grades: [
        ['0', 'ノッチングなし', () => rsa(0)],
        ['1', '肩甲骨の pillar（頚部下縁）に限局', () => rsa(1)],
        ['2', '下方スクリューに接する', () => rsa(2)],
        ['3', '下方スクリューを越えて広がる', () => rsa(3)],
        ['4', 'ベースプレートの下（中心ペグ付近）まで及ぶ', () => rsa(4)],
      ],
    },
    walch: {
      title: 'Walch 分類（修正版・OA の関節窩形態）',
      note: '軸位像（CT・腋窩撮影）で判定。上＝前方、下＝後方。青の点線は肩甲骨軸とその垂線（後捻 0°）。Walch 1999、B3・C2・D は 2016 年の修正版で追加',
      grades: [
        ['A1', '骨頭は求心位。軽度の中央侵食', () => axial({ bow: 12, head: [118, 100] })],
        ['A2', '高度の中央侵食（骨頭が関節窩へ陥入）', () => axial({ ant: [86, 58], post: [86, 142], bow: 30, head: [110, 100] }) + arrow(132, 100, 112, 100)],
        ['B1', '骨頭の後方亜脱臼。骨侵食なし（後方の裂隙狭小化・硬化・骨棘）', () => axial({ head: [122, 116], sclerosis: true, osteo: true }) + arrow(150, 84, 150, 100)],
        ['B2', '二重凹面（後方の neoglenoid と前方の paleoglenoid）', () => axial({ post: [66, 140], ridge: [82, 100], head: [110, 118] }) + note(96, 72, '稜')],
        ['B3', '単一凹面の後方侵食。後捻 15° 以上 または 後方亜脱臼 70% 以上', () => axial({ ant: [84, 62], post: [62, 136], bow: 6, head: [112, 112] })],
        ['C1', '形成不全による後捻 25° 以上（侵食によらない）', () => axial({ ant: [88, 66], post: [64, 126], bow: 5, head: [116, 102] }) + note(92, 160, '形成不全')],
        ['C2', '形成不全 ＋ 二重凹面 ＋ 後方亜脱臼', () => axial({ ant: [88, 66], post: [60, 128], ridge: [80, 94], head: [108, 114] })],
        ['D', '関節窩の前捻 または 骨頭の前方亜脱臼', () => axial({ ant: [68, 62], post: [86, 138], bow: 6, head: [122, 84] }) + arrow(150, 116, 150, 100)],
      ],
    },
    neer: {
      title: 'Neer 分類（上腕骨近位端骨折）',
      note: '転位＝1 cm 以上または 45° 以上の角状変形。正面像のみでの判定には限界あり',
      grades: [
        ['1', '1-part：骨折線はあるが転位なし', () => neer(1)],
        ['2', '2-part：1 つの骨片が転位（図は外科頚）', () => neer(2)],
        ['3', '3-part：2 つの骨片が転位（外科頚＋大結節）', () => neer(3)],
        ['4', '4-part：骨頭・大結節・小結節がすべて分離', () => neer(4)],
      ],
    },
    levy: {
      title: 'Levy 分類（RSA 後の肩峰・肩甲棘の疲労骨折）',
      note: '骨折線の位置＝三角筋起始のどこまでを含むか（Levy 2013）。正面像で見えない骨折は CT が必要（約2割）',
      grades: [
        ['0', '骨折なし', () => levy('0')],
        ['I', '前部・中部三角筋起始の一部を含む（肩峰の外側寄り）', () => levy('I')],
        ['II', '中部三角筋起始の全部と後部の一部を含む（肩鎖関節の高さ付近）', () => levy('II')],
        ['III', '中部・後部三角筋起始の全部を含む（肩甲棘の骨折）', () => levy('III')],
      ],
    },
    lazarus: {
      title: 'Lazarus 分類（関節窩コンポーネント周囲の透亮線）',
      note: 'ペグ型コンポーネントの透亮線（Lazarus 1999）。赤＝透亮線。図は正面像の模式',
      grades: [
        ['0', '透亮線なし', () => lazarus()],
        ['1', '1〜2本のペグに不完全な透亮線', () => lazarus({ part: [0] })],
        ['2', '1本のペグの全周に透亮線（他のペグに不完全なものがあってもよい）', () => lazarus({ full: [1], part: [0] })],
        ['3', '2本以上のペグの全周に透亮線', () => lazarus({ full: [0, 1] })],
        ['4', 'すべてのペグの全周に透亮線', () => lazarus({ full: [0, 1, 2] })],
        ['5', '明らかな弛み（コンポーネントの移動・傾き）', () => lazarus({ full: [0, 1, 2], loose: true })],
      ],
    },
    shield: {
      title: 'Stress shielding（非セメントステム周囲の骨吸収）',
      note: 'このアプリでの程度の目安。部位（大結節・内側 calcar・骨幹皮質）は「メモ」に記録してください（記載の推奨は Denard 2018）',
      grades: [
        ['0', 'なし', () => shield(0)],
        ['1', '軽度：大結節 または 内側 calcar の一部に皮質の菲薄化・骨吸収', () => shield(1)],
        ['2', '中等度：大結節と内側 calcar の両方、または一部の完全な骨吸収', () => shield(2)],
        ['3', '高度：大結節・calcar の完全な吸収や骨幹皮質の広い菲薄化', () => shield(3)],
      ],
    },
    gartner: {
      title: 'Gärtner 分類（石灰沈着性腱板炎）',
      note: '石灰の濃さと輪郭で判定（Gärtner・Heyer 1995）。III 型は吸収期のことが多い',
      grades: [
        ['I', '輪郭が明瞭で濃い（均一）', () => gartner('I')],
        ['II', '輪郭が不明瞭で濃い、または輪郭は明瞭で淡い', () => gartner('II')],
        ['III', '淡く雲状で輪郭がはっきりしない', () => gartner('III')],
      ],
    },
  };

  function render(key, grade) {
    const g = C[key].grades.find((x) => x[0] === grade);
    return svg(defs + g[2]());
  }

  global.XS = { CLASSES: C, render };
})(window);
