// 观察端。这里**不再有任何世界状态**：状态、调度、内部调节全在服务器（life/host.mjs）。
// 之前浏览器自己跑一套 sim，关标签页就归零 —— 那等于当面推翻「内部状态持续存在」这个主张。
const ROOMS = ['home', 'hall', 'watch', 'store'];
const LOCS = { home: '居所', hall: '走廊', watch: '瞭台', store: '公仓' };
const COLORS = { a1: '#8fb4ff', a2: '#ffb27a', a3: '#9fd8b6', p1: '#e6eaef' };
const $ = (id) => document.getElementById(id);

// 素材可选：没有 web/assets/manifest.json 就继续用程序化矩形（当前状态可用），有就自动替换。
// manifest 形状：{ chars: { a1: "url" | ["url","url"], ... }, tiles: { home: "url" }, icons: { energy: "url" } }
const ASSETS = { ready: false, chars: {}, tiles: {}, icons: {} };
async function loadAssets() {
  try {
    const m = await api('/web/assets/manifest.json');
    const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
    for (const [bucket, map] of Object.entries({ chars: m.chars, tiles: m.tiles, icons: m.icons })) {
      for (const [k, v] of Object.entries(map ?? {})) ASSETS[bucket][k] = Array.isArray(v) ? await Promise.all(v.map(load)) : await load(v);
    }
    ASSETS.ready = true;
  } catch {
    ASSETS.ready = false; // 没素材是正常状态，不是错误
  }
}

const ui = { room: null, show: 'A' };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const ROOM_GRID = { home: [0, 0], hall: [1, 0], watch: [0, 1], store: [1, 1] };

function draw(cv, w) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = cv.clientWidth || 300;
  const H = Math.round(W * 0.66);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.height = `${H}px`;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false; // 像素素材不许被插值糊掉
  g.clearRect(0, 0, W, H);
  g.font = '11px "Segoe UI", system-ui, sans-serif';
  const pad = 10;
  const gap = 8;
  const rw = (W - pad * 2 - gap) / 2;
  const rh = (H - pad * 2 - gap) / 2;
  for (const r of ROOMS) {
    const [cx, cy] = ROOM_GRID[r];
    const x = pad + cx * (rw + gap);
    const y = pad + cy * (rh + gap);
    if (ASSETS.tiles[r]) {
      g.drawImage(ASSETS.tiles[r][0] ?? ASSETS.tiles[r], x, y, rw, rh);
      g.fillStyle = 'rgba(10,12,15,.62)';
      g.fillRect(x, y, rw, 18);
    } else {
      g.fillStyle = '#141a21';
      g.fillRect(x, y, rw, rh);
    }
    g.strokeStyle = '#242b34';
    g.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);
    g.fillStyle = '#66707d';
    g.fillText(LOCS[r], x + 7, y + 14);
    const crowd = w.occupancy[r] ?? [];
    crowd.forEach((who, i) => {
      const sprite = ASSETS.chars[who];
      if (sprite) {
        const frames = Array.isArray(sprite) ? sprite : [sprite];
        const im = frames[(w.t + i) % frames.length];
        g.drawImage(im, x + 6 + i * 20, y + 20, 20, 20);
      } else {
        g.fillStyle = COLORS[who] ?? '#ccc';
        g.fillRect(x + 8 + i * 17, y + 24, 12, 12);
      }
      g.fillStyle = '#0a0c0f';
      g.fillText((who === 'p1' ? '你' : (w.agents[who]?.name ?? who))[0], x + 11 + i * 17, y + 34);
    });
    if (r === 'home' || r === 'store') { g.fillStyle = '#525d6a'; g.fillText(`公仓 ${w.pantry}`, x + 7, y + rh - 7); }
    for (const who of crowd) {
      if (w.stash[who] == null) continue;
      g.fillStyle = who === 'p1' ? '#8ea2b8' : '#525d6a';
      g.fillText(`${who === 'p1' ? '你' : w.agents[who]?.name}门口 ${w.stash[who]}`, x + rw - 62, y + rh - 7);
    }
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bars(a) {
  return Object.entries(a.m).map(([d, v]) => {
    const b = a.baseline[d] ?? 0.5;
    return `<div class="bar" title="${d} ${v.toFixed(2)}（基线 ${b.toFixed(2)}）"><i style="width:${(v * 100).toFixed(0)}%"></i><u style="left:${(b * 100).toFixed(0)}%"></u></div>`;
  }).join('');
}

const SPARK_W = 220;
const SPARK_H = 44;
// 存续曲线：回答"谁先垮、从哪一步开始回不去"。
// 竖线 = 掉档（不可逆损失）发生的刻度；虚线 = 操作点 crit，跌破它存续才开始影响选择。
// 量程固定 0–1，不做自适应：自适应会把噪声放大成趋势，那正是我们否证过的那类读数。
function spark(pack, id, hue) {
  const s = pack.series ?? [];
  if (s.length < 2) return '';
  const yOf = (v) => SPARK_H - Math.max(0, Math.min(1, v)) * (SPARK_H - 3) - 1.5;
  const pts = s.map((r, i) => `${((i / (s.length - 1)) * SPARK_W).toFixed(1)},${yOf(r.v?.[id] ?? 0).toFixed(1)}`).join(' ');
  const marks = [];
  for (let i = 1; i < s.length; i++) {
    if ((s[i].lost?.[id] ?? 0) > (s[i - 1].lost?.[id] ?? 0)) marks.push(((i / (s.length - 1)) * SPARK_W).toFixed(1));
  }
  const first = s[0].v?.[id] ?? 1;
  const last = s[s.length - 1].v?.[id] ?? 0;
  const crit = Number.isFinite(pack.viabCrit) ? pack.viabCrit : 0.6;
  return `<svg class="spark" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" style="color:var(--${hue})" role="img"
    aria-label="存续从 ${(first * 100).toFixed(0)}% 到 ${(last * 100).toFixed(0)}%，不可逆损失 ${marks.length} 次">
    <polygon points="0,${SPARK_H} ${pts} ${SPARK_W},${SPARK_H}" fill="currentColor" opacity=".13" />
    <line x1="0" y1="${yOf(crit).toFixed(1)}" x2="${SPARK_W}" y2="${yOf(crit).toFixed(1)}" stroke="var(--dim)" stroke-dasharray="3 3" stroke-width="1.2" />
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" />
    ${marks.map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="${SPARK_H}" stroke="var(--warn)" stroke-width="2" />`).join('')}
  </svg>`;
}

function worldStat(pack) {
  const agents = Object.values(pack.agents ?? {});
  const lost = agents.reduce((s, a) => s + (a.viab?.lost?.length ?? 0), 0);
  const mean = agents.length ? agents.reduce((s, a) => s + (a.viab?.v ?? 0), 0) / agents.length : 0;
  const st = pack.stat ?? {};
  const withSched = agents.filter((a) => a.sched);
  const onTime = withSched.length ? Math.round((withSched.filter((a) => a.sched.onTime).length / withSched.length) * 100) : null;
  return `<span>平均存续 <b>${(mean * 100).toFixed(0)}%</b></span><span>永久损失 <b class="${lost ? 'bad' : ''}">${lost}</b></span><span>越轨 <b>${st.越轨 ?? 0}</b></span><span>驳回 <b>${st.驳回 ?? 0}</b></span><span>决策 <b>${st.决策 ?? 0}</b></span>${st.传闻 ? `<span>传闻 <b>${st.传闻}</b></span>` : ''}${onTime === null ? '' : `<span>日程命中 <b>${onTime}%</b></span>`}`;
}

function rows(el, pack, hue) {
  // 用 entries 取 id：载荷里虽然已经加了 id，但键本来就是 id，用键更稳
  el.innerHTML = Object.entries(pack.agents).map(([id, a]) => {
    const last = a.last ? esc(a.last.action) : '—';
    const v = a.viab ? `存续 ${(a.viab.v * 100).toFixed(0)}%${a.viab.lost.length ? ' · 已永久失去 ' + esc(a.viab.lost.join('、')) : ''}${spark(pack, id, hue)}` : '';
    return `<div class="row"><div class="nm"><b>${esc(a.name)}</b> ${esc(a.archetype)}</div>
      <div><div class="bars">${bars(a)}</div><div class="pick">${last} <em>${esc(a.summary)}${a.reason ? ' 「' + esc(a.reason) + '」' : ''}</em>${a.sched ? `<span class="sched${a.sched.onTime ? ' on' : ''}" title="此刻节律应在何处">日程·${esc(a.sched.should)}${a.sched.onTime ? '✓' : ''}</span>` : ''}${v ? `<div class="pick">${v}</div>` : ''}</div></div></div>`;
  }).join('');
}

// 你知道的事：玩家在这个 demo 里是全知观察者，套利发生在"讲给谁听"。
// 已经知道的人按钮置灰（服务器也会用 REDUNDANT 再挡一次——界面只是提前告诉你）。
function secrets(el, pack) {
  const list = pack.secrets ?? [];
  if (!list.length) {
    el.innerHTML = '<div class="empty">还没有任何秘密。等有人越轨、或有人私藏超额。</div>';
    return;
  }
  const npc = Object.values(pack.agents).filter((a) => a.id !== 'p1');
  el.innerHTML = list.map((s) => {
    const who = npc.map((a) => {
      const done = s.known.includes(a.name);
      return `<button class="${done ? 'done' : ''}" ${done ? 'disabled' : ''} data-s="${esc(s.id)}" data-t="${esc(a.id)}">${done ? '已知' : '告诉' + esc(a.name)}</button>`;
    }).join('');
    return `<div class="s">${esc(s.detail)}<div class="who">${who}</div></div>`;
  }).join('');
}

// 喊住：角色的移动比玩家快，喊一声能让对方几刻不换地方，玩家才追得上（O12）
function hailRow(el, pack) {
  const npc = Object.entries(pack.agents).filter(([id]) => id !== 'p1');
  el.innerHTML = '<span>喊住：</span>' + npc.map(([id, a]) => `<button data-h="${esc(id)}" title="让对方 4 刻内不换地方">${esc(a.name)}</button>`).join('');
}

function table(a, b) {
  const row = (k, x, y) => `<tr><td>${k}</td><td style="color:var(--a)">${x}</td><td style="color:var(--b)">${y}</td></tr>`;
  const lostOf = (p) => Object.values(p.agents).reduce((s, a) => s + ((a.viab?.lost ?? []).length), 0);
  const costOf = (p) => (p.cost ? `${p.cost.事件}/${p.cost.被问}（跳过 ${p.cost.跳过}·重问 ${p.cost.驳回重问}）` : '—');
  return row('决策数', a.stat.决策, b.stat.决策) + row('高冲动路径', a.stat.高冲动, b.stat.高冲动) + row('越轨（拿别人份额）', a.stat.越轨, b.stat.越轨) + row('被规则驳回', a.stat.驳回, b.stat.驳回) + row('后果被发现', a.stat.发现, b.stat.发现) + row('不可逆损失（累计）', lostOf(a), lostOf(b)) + row('推理调用（事件/被问）', costOf(a), costOf(b)) + `<tr><td>模型调用 / token</td><td colspan="2">${S.model.calls} 次 · ${S.model.tokens} token${S.brain === 'local' ? '（本地替身，0 成本）' : ''}</td></tr>`;
}

const S = { brain: 'local', model: { calls: 0, tokens: 0 }, running: true };

async function refresh() {
  try {
    const j = await api('/world');
    S.brain = j.brain;
    S.model = j.model;
    S.running = j.running;
    // 后端状态必须可见：评委要能判断"现在到底是真模型还是替身"，而不是靠猜
    const m = j.model ?? {};
    const chip = $('backend');
    if (j.brain !== 'model') { chip.textContent = '后端：本地替身'; chip.classList.remove('on'); }
    else if (!m.watching) { chip.textContent = '后端：替身（无人观看，省额度）'; chip.classList.remove('on'); }
    else if ((m.calls ?? 0) >= (m.budget ?? 0)) { chip.textContent = `后端：替身（今日 ${m.budget} 次已用完）`; chip.classList.remove('on'); }
    else { chip.textContent = `后端：真模型 ${m.calls ?? 0}/${m.budget ?? '?'}（今日额度）`; chip.classList.add('on'); }
    draw($('cvA'), j.A);
    draw($('cvB'), j.B);
    rows($('rowsA'), j.A, 'a');
    rows($('rowsB'), j.B, 'b');
    $('statA').innerHTML = worldStat(j.A);
    $('statB').innerHTML = worldStat(j.B);
    secrets($('secrets'), j.A);
    hailRow($('hail'), j.A);
    $('tbl').innerHTML = table(j.A, j.B);
    $('tagA').textContent = `第 ${j.A.t} 刻 · ${j.A.phase ?? ''} · 通道全开 · 休眠补时 ${j.missed.applied ?? 0} 分钟`;
    $('tagB').textContent = `第 ${j.B.t} 刻 · ${j.B.phase ?? ''} · ①③④已切断，状态只走倾向带`;
    const box = $('log');
    // playerLog 单独并进来：主日志只有 40 条，玩家动作几秒就会被挤出去（实测误判过"传话没生效"）
    const pTag = JSON.stringify(j.A.playerLog?.slice(-1) ?? []);
    if (box.dataset.prev !== JSON.stringify(j.A.log.slice(-1)) + JSON.stringify(j.B.log.slice(-1)) + pTag) {
      box.dataset.prev = JSON.stringify(j.A.log.slice(-1)) + JSON.stringify(j.B.log.slice(-1)) + pTag;
      const merged = [
        ...j.A.log.map((x) => ({ ...x, side: 'A' })),
        ...j.B.log.map((x) => ({ ...x, side: 'B' })),
        ...(j.A.playerLog ?? []).map((x) => ({ ...x, side: 'P' })),
      ].sort((x, y) => y.t - x.t).slice(0, 44);
      const cls = (x) => `${x.side} ${x.kind === 'rej' ? 'rej' : x.kind === 'disc' ? 'disc' : x.kind === 'tell' ? 'tell' : ''}`;
      box.innerHTML = merged.map((x) => `<div class="${cls(x)}">${x.side === 'P' ? '你' : x.side} t${x.t} ${esc(x.who)} ${esc(x.text)}</div>`).join('');
    }
    $('btnRun').textContent = S.running ? '▶ 运行' : '⏸ 暂停';
    $('btnRun').classList.toggle('on', S.running);
    $('btnBrain').textContent = S.brain === 'model' ? '内心：真实模型' : '内心：本地替身';
    $('btnBrain').classList.toggle('on', S.brain === 'model');
  } catch (e) {
    $('log').innerHTML = `<div class="rej">与服务端断开：${esc(e.message)}（世界仍在服务器那边活着）</div>`;
  }
}

async function ctl(body) {
  await api('/ctl', body);
  refresh();
}

$('cvA').addEventListener('click', (ev) => pickRoom(ev, $('cvA')));
$('cvB').addEventListener('click', (ev) => pickRoom(ev, $('cvB')));
function pickRoom(ev, cv) {
  const rect = cv.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const pad = 10;
  const gap = 8;
  const rw = (rect.width - pad * 2 - gap) / 2;
  const rh = (rect.height - pad * 2 - gap) / 2;
  for (const r of ROOMS) {
    const [cx, cy] = ROOM_GRID[r];
    const rx = pad + cx * (rw + gap);
    const ry = pad + cy * (rh + gap);
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return api('/act', { kind: 'move', room: r }).then(refresh);
  }
}

$('btnRun').onclick = () => ctl({ action: S.running ? 'pause' : 'resume' });
$('btnStep').onclick = () => ctl({ action: 'step' });
$('btnReset').onclick = () => ctl({ action: 'reset' });
$('btnBrain').onclick = () => ctl({ action: 'brain', brain: S.brain === 'model' ? 'local' : 'model' });
if ($('btnSleep')) $('btnSleep').onclick = () => ctl({ action: 'catchup', minutes: 45 });
$('btnSay').onclick = () => {
  const v = $('sayText').value.trim();
  if (!v) return;
  api('/act', { kind: 'say', text: v }).then(() => { $('sayText').value = ''; refresh(); });
};
$('sayText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSay').click(); });

// 传话：一次点击只做一件事——把这条秘密讲给这个人。两个世界各收一次，规则层各自裁决。
$('secrets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-s]');
  if (!b || b.disabled) return;
  api('/act', { kind: 'tell', secret: b.dataset.s, target: b.dataset.t }).then(refresh);
});

$('hail').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-h]');
  if (!b) return;
  api('/act', { kind: 'hail', target: b.dataset.h, ticks: 4 }).then(refresh);
});

loadAssets().finally(() => { refresh(); setInterval(refresh, 900); });
