/* =====================================================================
 * 精力助手 · 《大脑效率革命》 v2
 * 零依赖纯前端 + 极简本地服务（localhost 自动导入 inbox/tasks.json）
 * 任务来源：AI 拆解的 tasks.json（真实判断）+ 手动添加（显式选类型）
 * ===================================================================== */

/* ---------- 安全存储（file:// 下 localStorage 可能受限，降级为内存） ---------- */
const _mem = {};
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem('brain-gears:' + k);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return _mem[k] ?? fallback; }
  },
  set(k, v) {
    try { localStorage.setItem('brain-gears:' + k, JSON.stringify(v)); }
    catch (e) { _mem[k] = v; }
  },
  del(k) {
    try { localStorage.removeItem('brain-gears:' + k); }
    catch (e) { delete _mem[k]; }
  }
};

/* ---------- 全局状态 ---------- */
let settings = store.get('settings', { wakeTime: '07:30', sleepHours: 7, workRatio: 75, theme: 'light' });
let tasks = store.get('tasks', []);
let history = store.get('history', []);
let sleepLog = store.get('sleepLog', []);
let daily = store.get('daily', { date: '', wakeTime: '07:30', sleepHours: 7, schedule: [] });

/* ---------- 工具函数 ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, '0');

function timeToMin(t) {
  if (!t) return 7 * 60 + 30;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minToTime(m) {
  m = ((m % 1440) + 1440) % 1440;
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
}
function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function sameDay(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }

/* ---------- 挡位模型 ---------- */
const GEAR_META = {
  1: { name: '挡位1 · 慢速 / 充电', short: '充电' },
  2: { name: '挡位2 · 心流 / 深度', short: '心流' },
  3: { name: '挡位3 · 冲刺 / 快速', short: '冲刺' }
};

const SUGGESTIONS = {
  1: [
    '起身走动 5~10 分钟（散步 / 拉伸），给大脑"换血"',
    '定时小睡 20 分钟（一定设闹钟，别超过）',
    '喝一杯水 + 远眺窗外 2 分钟，让眼睛和注意力复位',
    '做一件无脑小事：整理桌面 / 清空收件箱，找回掌控感'
  ],
  2: [
    '关掉所有通知，手机静音放远，进入单任务模式',
    '写下眼前这件事的"下一步动作"，越具体越好',
    '设定一个 25 分钟专注块（番茄钟），只做这一件',
    '把"多线并进"改成"一次一件"，保护心流不被切碎'
  ],
  3: [
    '设定明确时限（比如 20 分钟搞定），倒计时开始',
    '列出"最小可交付"，先完成最重要那一件',
    '快速决策：先完成、再完美，别在细节上耗住',
    '冲刺结束后，务必补一段 15 分钟充电再继续'
  ]
};

/* 「主动换挡」提示：检测出挡3/挡1 时，指引怎么切回挡2 */
const SHIFT_TIPS = {
  3: '压力偏大 → 先设个 20 分钟时限，只做最重要那一件，降回挡2',
  1: '精力偏低 → 起身走 5 分钟 / 喝水远眺 2 分钟，把自己提进挡2'
};
/* 「我卡住了 → 换轨」的创造性重启建议（对应书里「卡住→换创造性活动」） */
const CREATIVE_RESET = [
  '换轨重启：站起来走 5 分钟，边走边听一段有声书或播客',
  '随手画两笔 / 涂鸦，把卡住的脑子交给手',
  '读一段与手头无关的小说或文章，让想象力松绑',
  '做一件 5 分钟的无脑小事（倒水 / 整理桌面），再回来'
];
/* 需要跨「重新排程」保留的即时恢复块标题 */
const STUCK_TITLES = ['充电 · 卡住恢复', '换轨 · 创造性重启', '充电 · 短休息'];

/* 类型 → 挡位 / 默认用脑量（透明映射，非"从文字猜"） */
// creative（发散/创意）= 放松但专注态（挡2）、用脑量中；排程时落到低唤醒的清晨/深夜（见 assignTasks 的 'offpeak'）
const typeGear = (type) => (type === 'sprint' ? 3 : (type === 'deep' || type === 'creative') ? 2 : 1);
const typeLoad = { deep: '高', creative: '中', routine: '低', sprint: '高', rest: '低' };
const loadRank = { '高': 3, '中': 2, '低': 1 };
const priorityRank = (p) => (p === 'high' ? 3 : p === 'medium' ? 2 : 1);

/* ---------- 任务构造 ---------- */
function createTask(title, type, source, opts = {}) {
  type = ['deep', 'creative', 'routine', 'sprint', 'rest'].includes(type) ? type : 'routine';
  return {
    id: uid(), title: oneLine(title), type,
    load: opts.load || typeLoad[type],
    estMin: Number(opts.estMin) || 30,
    priority: ['high', 'medium', 'low'].includes(opts.priority) ? opts.priority : 'medium',
    gear: typeGear(type), done: false, doneAt: null,
    source: source || '手动'
  };
}

/* ---------- JSON 导入（AI 出的 tasks.json / inbox） ---------- */
// 语义：AI 任务（source 非"手动"）以本次导入为准整体替换；手动任务始终保留
function importTasksJson(obj) {
  const arr = obj.tasks || (Array.isArray(obj) ? obj : []);
  const src = obj.source || 'inbox';
  // 按 source 去重：仅替换本次涉及到的来源，其它来源（含手动）保留
  const incoming = new Set();
  arr.forEach((t) => { if (t && t.title) incoming.add(t.source || src); });
  if (!incoming.size) incoming.add(src);
  tasks = tasks.filter((t) => t.source === '手动' || !incoming.has(t.source));
  let n = 0;
  arr.forEach((t) => {
    if (!t || !t.title) return;
    const type = ['deep', 'creative', 'routine', 'sprint', 'rest'].includes(t.type) ? t.type : 'routine';
    tasks.push({
      id: uid(), title: oneLine(t.title), type,
      load: ['低', '中', '高'].includes(t.load) ? t.load : typeLoad[type],
      estMin: Number(t.estMin) || 30,
      priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
      gear: typeGear(type), done: !!t.done, doneAt: null,
      source: t.source || src
    });
    n++;
  });
  return n;
}

/* ---------- 精力节律引擎 ---------- */
function energyAt(h) {
  if (h < 0.5) return 55 + (h / 0.5) * 15;
  if (h < 3)   return 70 + (h - 0.5) / 2.5 * 25;
  if (h < 5)   return 95 - (h - 3) / 2 * 15;
  if (h < 7)   return 80 - (h - 5) / 2 * 30;
  if (h < 9)   return 50 + (h - 7) / 2 * 25;
  if (h < 13)  return 75 - (h - 9) / 4 * 25;
  return Math.max(30, 50 - (h - 13) / 2 * 20);
}
function sleepFactor(sleepHours) {
  if (sleepHours >= 8) return 1.05;
  if (sleepHours >= 7) return 1.0;
  if (sleepHours >= 6) return 0.9;
  return 0.75;
}

/* ---------- 调度引擎 ---------- */
// 按排程优先级给任务排序：冲刺(按优先级) → 深度(高用脑量优先) → 常规(低用脑量优先)
function orderPendingTasks(list) {
  const bucket = { sprint: [], deep: [], creative: [], routine: [], rest: [] };
  list.forEach((t) => bucket[t.type].push(t));
  bucket.sprint.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
  bucket.deep.sort((a, b) => (loadRank[b.load] || 2) - (loadRank[a.load] || 2) || priorityRank(b.priority) - priorityRank(a.priority));
  bucket.creative.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
  bucket.routine.sort((a, b) => (loadRank[a.load] || 2) - (loadRank[b.load] || 2) || priorityRank(b.priority) - priorityRank(a.priority));
  bucket.rest.sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
  return [bucket.sprint, bucket.deep, bucket.creative, bucket.routine, bucket.rest];
}

function buildDaySchedule(pendingTasks) {
  const wake = timeToMin(settings.wakeTime);
  const sleepH = Number(settings.sleepHours) || 7;
  const now = nowMin();
  const dayEnd = Math.min(Math.max(wake + 13 * 60, 21 * 60), 23 * 60 + 30);

  const slots = [];
  for (let t = wake; t < dayEnd; t += 30) {
    const hSince = (t - wake) / 60;
    slots.push({ start: t, end: t + 30, energy: energyAt(hSince) * sleepFactor(sleepH) });
  }

  // 充电块：按「工作/休息占比」动态分配；睡眠不足额外加充电
  const charge = new Set();
  const markCharge = (a, b) => {
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].start < b && slots[i].end > a) charge.add(i);
    }
  };
  const totalMin = dayEnd - wake;
  let restMin = Math.round(totalMin * (100 - settings.workRatio) / 100);
  // 午间充电固定在真实中午 12:00；起床已过 11:30 就不再设「午间」，改成均匀短休息
  let lunchStart = -1, lunchEnd = -1;
  if (wake <= 11 * 60 + 30) {
    const lunchMin = Math.min(75, Math.max(30, Math.round(restMin * 0.35)));
    lunchStart = 12 * 60;
    lunchEnd = lunchStart + lunchMin;
    markCharge(lunchStart, lunchEnd);
    restMin -= lunchMin;
  }
  if (sleepH < 6) restMin += 30;
  const nBreaks = Math.max(2, Math.round(totalMin / 150));
  const perBreak = Math.max(10, Math.round(restMin / nBreaks));
  for (let i = 1; i <= nBreaks; i++) {
    const t = wake + Math.round((i * totalMin) / (nBreaks + 1));
    if (lunchStart >= 0 && Math.abs(t - lunchStart) < 120) continue;
    markCharge(t, t + perBreak);
  }

  // 只把任务排进「尚未过去」的工作槽位；已过去的时间只作地形图背景，不再排任务。
  // 当前 30 分钟槽位：刚开始（未过半）仍可排，快结束才跳过。
  const GRACE = 15; // 分钟；30 分钟槽位开始后 15 分钟内仍可用
  const workSlots = slots.map((_, i) => i).filter((i) => {
    if (charge.has(i)) return false;
    if (slots[i].start >= now) return true;   // 未来的槽位
    return now - slots[i].start <= GRACE;      // 刚开始的当前槽位
  });
  const assign = new Array(slots.length).fill(null);

  const [sprint, deep, creative, routine, rest] = orderPendingTasks(pendingTasks);

  const leftover = [
    ...assignTasks(sprint, 'earliest', slots, assign, charge, workSlots),
    ...assignTasks(deep, 'highest', slots, assign, charge, workSlots),
    ...assignTasks(creative, 'offpeak', slots, assign, charge, workSlots),
    ...assignTasks(routine, 'lowest', slots, assign, charge, workSlots),
    ...assignTasks(rest, 'lowest', slots, assign, charge, workSlots),
  ];

  const sched = [];
  slots.forEach((sl, i) => {
    const tid = assign[i];
    if (sl.end <= now) {
      sched.push({ start: sl.start, end: sl.end, kind: 'past', title: '已过去', gear: 0 });
    } else if (charge.has(i)) {
      const lunch = lunchStart >= 0 && sl.start >= lunchStart && sl.start < lunchEnd;
      sched.push({ start: sl.start, end: sl.end, kind: lunch ? 'charge' : 'rest', title: lunch ? '午间充电' : '短休息', gear: 1 });
    } else if (tid) {
      const t = tasks.find((x) => x.id === tid);
      if (t) {
        if (t.type === 'rest') sched.push({ start: sl.start, end: sl.end, kind: 'rest', taskId: tid, title: t.title, gear: 1, done: t.done });
        else sched.push({ start: sl.start, end: sl.end, kind: 'task', taskId: tid, title: t.title, gear: t.gear, done: t.done });
      }
    } else {
      sched.push({ start: sl.start, end: sl.end, kind: 'gap', title: '自由时间', gear: 0 });
    }
  });

  return { schedule: mergeSchedule(sched), leftover };
}

function assignTasks(list, mode, slots, assign, charge, workSlots) {
  const avail = new Set(workSlots.filter((i) => assign[i] === null && !charge.has(i)));
  const sorted = () => [...avail].sort((a, b) => a - b);
  const leftover = [];
  // 「offpeak」模式：创意/发散任务落到低唤醒的边缘（醒后 1.5h 内 或 dayEnd 前 2h 内），而非午前峰值
  const wake = slots[0].start;
  const dayLen = (slots[slots.length - 1].end - wake) / 60;
  const cost = (x) => {
    if (mode !== 'offpeak') return slots[x].energy;
    const hSince = (slots[x].start - wake) / 60;
    const edge = hSince < 1.5 || hSince > dayLen - 2;
    return slots[x].energy - (edge ? 45 : 0);
  };

  for (const t of list) {
    const n = Math.max(1, Math.round((t.estMin || 30) / 30));
    const idx = sorted();
    let best = null, bestScore = null;
    for (let i = 0; i + n <= idx.length; i++) {
      const win = idx.slice(i, i + n);
      if (win[n - 1] - win[0] !== n - 1) continue;
      const score = win.reduce((s, x) => s + cost(x), 0);
      let pick;
      if (mode === 'earliest') pick = best === null || win[0] < best[0];
      else if (mode === 'highest') pick = bestScore === null || score > bestScore;
      else pick = bestScore === null || score < bestScore;
      if (pick) { best = win; bestScore = score; }
    }
    if (!best) { leftover.push(t); continue; }
    best.forEach((x) => { assign[x] = t.id; avail.delete(x); });
  }
  return leftover;
}

function mergeSchedule(sched) {
  const out = [];
  for (const e of sched) {
    const prev = out[out.length - 1];
    const sameKey = prev && prev.kind === e.kind && (prev.taskId || prev.title) === (e.taskId || e.title);
    if (sameKey) prev.end = e.end;
    else out.push({ ...e });
  }
  return out;
}

/* ---------- 当下安排 ---------- */
function currentAction() {
  const now = nowMin();
  let cur = daily.schedule.find((e) => now >= e.start && now < e.end);
  if (!cur) cur = daily.schedule.find((e) => e.start >= now);
  return cur || null;
}

/* ---------- 档位检测 ---------- */
function detectGear(answers) {
  const { energy, focus, pressure } = answers;
  if (pressure === 2) return 3;             // 焦虑赶时间 → 冲刺
  if (pressure === 1 && energy <= 1) return 3; // 适中压力 + 精力不高 → 偏紧绷
  if (energy === 0 || focus === 0) return 1;   // 疲惫 / 完全无法集中 → 充电
  return 2;                                    // 其余 → 心流（focus=2 且无压力 = 高心流）
}
function detectNote(answers) {
  if (answers.focus === 2 && answers.pressure === 0 && answers.energy >= 1) {
    return '现在是你最清晰的「高心流」窗口，适合啃最难的那件事。';
  }
  return '';
}
function lastDetectToday() {
  const det = history.filter((h) => sameDay(h.ts));
  return det.length ? det[det.length - 1] : null;
}

/* =====================================================================
 * 渲染
 * ===================================================================== */
const $ = (s) => document.querySelector(s);

function render() {
  renderClock();
  renderNow();
  renderTimeline();
  renderTaskList();
  renderQueue();
  renderReview();
  renderBadge();
}

function renderClock() {
  const d = new Date();
  $('#clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function renderBadge() {
  const badge = $('#gearBadge');
  // 优先显示今天最近一次检测出的挡位；没有检测记录再退回日程当前段
  const last = lastDetectToday();
  const cur = currentAction();
  const g = (last && last.gear) || (cur && cur.gear) || 0;
  badge.dataset.gear = g;
  badge.textContent = g ? GEAR_META[g].name : '挡位 · 待检测';
}

function renderNow() {
  const cur = currentAction();
  const body = $('#nowBody');
  if (!cur) {
    body.innerHTML = '<div class="now-empty">今天没有安排。先去「设置」汇报起床/睡眠，或到「任务」导入任务。</div>';
    return;
  }
  // 优先用今天最近一次检测出的挡位（身体「此刻」的真实状态），没有检测再退回日程段挡位
  const last = lastDetectToday();
  const g = (last && last.gear) || cur.gear;
  const timeRange = minToTime(cur.start) + ' – ' + minToTime(cur.end);
  const suggestions = cur.title === '换轨 · 创造性重启' ? CREATIVE_RESET : (SUGGESTIONS[g] || []);
  const gearChip = g ? `<span class="now-gear" data-gear="${g}">${GEAR_META[g].name}</span>` : '';
  const meta = cur.kind === 'task'
    ? `预计 ${timeRange}`
    : (cur.kind === 'charge' ? `充电时段 ${timeRange} · 别硬撑，休息也是效率`
      : cur.kind === 'rest' ? `休息时段 ${timeRange} · 短休回血，再战` : `自由时段 ${timeRange}`);

  // 检测结果提示 + 「怎么切回挡2」的主动换挡指引
  let detectLine = '';
  if (last) {
    const d = new Date(last.ts);
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const shift = g !== 2 && SHIFT_TIPS[g] ? `<div class="now-shift">${escapeHtml(SHIFT_TIPS[g])}</div>` : '';
    detectLine = `<div class="now-detect">根据你 ${hm} 的检测，现在更像 <b data-gear="${g}">${GEAR_META[g].short}</b></div>${shift}`;
  }

  body.innerHTML = `
    ${gearChip}
    <div class="now-action">${escapeHtml(oneLine(cur.title))}</div>
    <div class="now-meta">${meta}</div>
    ${detectLine}
    ${g ? `<ul class="now-suggestions">${suggestions.slice(0, 3).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
  `;
}

function renderTimeline() {
  const el = $('#timeline');
  $('#dayMeta').textContent = `起床 ${settings.wakeTime} · 睡眠 ${settings.sleepHours}h · 共 ${daily.schedule.length} 段`;
  const now = nowMin();
  const rows = daily.schedule.map((e) => {
    const cls = e.kind === 'charge' ? 'charge' : e.kind === 'rest' ? 'rest' : e.kind === 'gap' ? 'gap' : e.kind === 'past' ? 'past' : 'task';
    const done = e.done ? ' done' : '';
    const isNow = now >= e.start && now < e.end;
    const nowCls = isNow ? ' is-now' : '';
    const t = oneLine(e.title);
    return `<div class="tl-row${nowCls}">
      <div class="tl-time">${minToTime(e.start)}</div>
      <div class="tl-block ${cls}${done}" title="${escapeHtml(t)}">${escapeHtml(t)}</div>
    </div>`;
  }).join('');
  el.innerHTML = rows || '<div class="now-empty">暂无时间轴。</div>';
}

function renderTaskList() {
  const el = $('#taskList');
  if (!tasks.length) {
    el.innerHTML = '<div class="hint">还没有任务。跑 <code>/decompose-tasks 你的md</code> 生成 inbox，再点「重新读取 inbox」；或手动添加。</div>';
    return;
  }
  const todayIds = new Set(daily.schedule.filter((e) => e.taskId).map((e) => e.taskId));
  const order = { sprint: 0, deep: 1, creative: 2, routine: 3, rest: 4 };
  const sorted = [...tasks].sort((a, b) => (a.done - b.done) || order[a.type] - order[b.type] || priorityRank(b.priority) - priorityRank(a.priority));
  el.innerHTML = sorted.map((t) => {
    const dayTag = t.done ? '' : `<span class="tag tag-day">${todayIds.has(t.id) ? '今天' : '待排'}</span>`;
    return `
    <div class="task ${t.done ? 'done' : ''}" data-id="${t.id}">
      <input type="checkbox" ${t.done ? 'checked' : ''} data-toggle="${t.id}">
      <div class="t-main">
        <div class="t-title">${escapeHtml(oneLine(t.title))}</div>
        <div class="t-meta">
          ${dayTag}
          <span class="tag tag-${t.type}">${typeLabel(t.type)}</span>
          <span class="tag tag-load">用脑量 ${t.load}</span>
          <span class="tag tag-load">${t.estMin} 分钟</span>
          ${t.priority === 'high' ? '<span class="tag tag-sprint">优先</span>' : ''}
          ${t.source ? `<span class="tag tag-load">${escapeHtml(t.source)}</span>` : ''}
        </div>
      </div>
      <button class="t-del" data-del="${t.id}" title="删除">×</button>
    </div>
  `;
  }).join('');
}

// 「队列」页：今天剩余（带时间）+ 待排（按优先级，不预排时间）
function renderQueue() {
  const el = $('#queueList');
  const pending = tasks.filter((t) => !t.done);
  if (!pending.length) {
    el.innerHTML = '<div class="hint">没有待完成任务。</div>';
    return;
  }
  const todayIds = new Set(daily.schedule.filter((e) => e.taskId).map((e) => e.taskId));

  const todayItems = daily.schedule
    .filter((e) => e.kind === 'task' && e.taskId)
    .sort((a, b) => a.start - b.start)
    .map((e) => {
      const t = tasks.find((x) => x.id === e.taskId && !x.done);
      return t ? { task: t, time: minToTime(e.start) } : null;
    })
    .filter(Boolean);

  const backlog = orderPendingTasks(pending.filter((t) => !todayIds.has(t.id))).flat();

  const itemHTML = (t, time) => `
    <div class="queue-item">
      <span class="queue-time">${time || '—'}</span>
      <span class="queue-title">${escapeHtml(oneLine(t.title))}</span>
      <span class="tag tag-${t.type}">${typeLabel(t.type)}</span>
    </div>`;

  const parts = ['<div class="hint">以后的日子会等你汇报当天的起床时间后再排（作息每天不同），所以这里只按优先级排队，不预排时间。</div>'];
  if (todayItems.length) {
    parts.push('<div class="queue-dayhead">今天 · 剩余</div>');
    todayItems.forEach((it) => parts.push(itemHTML(it.task, it.time)));
  }
  if (backlog.length) {
    parts.push('<div class="queue-dayhead">待排 · 之后自动安排</div>');
    backlog.forEach((t) => parts.push(itemHTML(t, '')));
  }
  el.innerHTML = parts.join('');
}

function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function last7Days() {
  const out = []; const d = new Date();
  for (let i = 6; i >= 0; i--) {
    const x = new Date(d); x.setDate(d.getDate() - i);
    out.push({ key: dayKey(x.getTime()), label: (x.getMonth() + 1) + '/' + x.getDate() });
  }
  return out;
}
function streakDays() {
  const days = new Set(tasks.filter((t) => t.doneAt).map((t) => dayKey(t.doneAt)));
  const d = new Date();
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1); // 今天还没完成，就从昨天起算
  let n = 0;
  while (days.has(dayKey(d.getTime()))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function renderReview() {
  const done = tasks.filter((t) => t.done).length;
  const total = tasks.length;
  const det = history.filter((h) => sameDay(h.ts));
  $('#reviewDate').textContent = '今日复盘 · ' + todayStr();
  const dist = { 1: 0, 2: 0, 3: 0 };
  if (det.length) det.forEach((h) => { if (dist[h.gear] != null) dist[h.gear]++; });
  else daily.schedule.forEach((e) => { if (e.gear) dist[e.gear] = (dist[e.gear] || 0) + 1; });

  const chargeMin = daily.schedule.filter((e) => e.kind === 'charge' || e.kind === 'rest').reduce((s, e) => s + (e.end - e.start), 0);
  const workMin = daily.schedule.filter((e) => e.kind === 'task').reduce((s, e) => s + (e.end - e.start), 0);

  $('#reviewStats').innerHTML = `
    <div class="stat"><div class="num">${done}/${total}</div><div class="lbl">已完成 / 总任务</div></div>
    <div class="stat"><div class="num">${det.length}</div><div class="lbl">今日档位检测</div></div>
    <div class="stat"><div class="num">${Math.round(workMin / 60 * 10) / 10}h</div><div class="lbl">安排工作/学习</div></div>
    <div class="stat"><div class="num">${Math.round(chargeMin / 60 * 10) / 10}h</div><div class="lbl">安排充电/休息</div></div>
  `;
  const gearSrc = det.length ? '实际检测分布' : '计划分布（今日暂无检测）';
  const max = Math.max(1, ...Object.values(dist));
  $('#reviewGears').innerHTML = `<div class="hint">${gearSrc}</div>` + [1, 2, 3].map((g) => `
    <div class="bar-row">
      <span>${GEAR_META[g].name.split(' · ')[1]}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(dist[g] / max * 100).toFixed(0)}%;background:var(--gear-${g})"></div></div>
      <span>${dist[g]}</span>
    </div>
  `).join('');

  // —— 累积 · 趋势（找到心火：可衡量的进步）——
  const streak = streakDays();
  const doneAll = tasks.filter((t) => t.done).length;
  const days7 = last7Days();
  const donePerDay = days7.map((d) => tasks.filter((t) => t.doneAt && dayKey(t.doneAt) === d.key).length);
  const sleepMap = {}; sleepLog.forEach((s) => { if (s && s.date) sleepMap[s.date] = s.sleepHours; });
  const maxDone = Math.max(1, ...donePerDay);
  const barH = (v, mx) => (v ? Math.max(6, Math.round(v / mx * 48)) : 0);

  $('#reviewTrend').innerHTML = `
    <div class="trend-stats">
      <div class="stat"><div class="num">${streak}</div><div class="lbl">连续打卡（天）</div></div>
      <div class="stat"><div class="num">${doneAll}</div><div class="lbl">累计完成</div></div>
    </div>
    <div class="trend-block">
      <div class="trend-title">近 7 天完成</div>
      <div class="mini-bars">
        ${days7.map((d, i) => `<div class="mini-bar-col"><span class="mini-val">${donePerDay[i] || ''}</span><div class="mini-bar" style="height:${barH(donePerDay[i], maxDone)}px"></div><span class="mini-lbl">${d.label}</span></div>`).join('')}
      </div>
    </div>
    <div class="trend-block">
      <div class="trend-title">近 7 天睡眠（小时）</div>
      <div class="mini-bars">
        ${days7.map((d, i) => {
          const s = sleepMap[d.key] != null ? sleepMap[d.key] : null;
          return `<div class="mini-bar-col"><span class="mini-val">${s != null ? s : ''}</span><div class="mini-bar mini-bar-sleep" style="height:${s != null ? Math.max(6, Math.round(s / 10 * 48)) : 0}px"></div><span class="mini-lbl">${s != null ? s : '—'}</span></div>`;
        }).join('')}
      </div>
    </div>
  `;
}

function typeLabel(t) { return t === 'deep' ? '深度' : t === 'creative' ? '创意' : t === 'sprint' ? '冲刺' : t === 'rest' ? '休息' : '常规'; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 标题里若混入换行/制表/连续空格，会在地形图/列表里显示成“断行/截断”，统一压成单行
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/* ---------- 提示 toast ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------- inbox 自动导入 ---------- */
function loadInbox(silent) {
  return fetch('/inbox/tasks.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((obj) => {
      const n = importTasksJson(obj);
      reschedule();
      if (n > 0 || !silent) toast('已从 inbox 导入 ' + n + ' 个任务');
      return n;
    })
    .catch((e) => {
      if (!silent) toast('无法读取 inbox/tasks.json（' + e.message + '）。请用「启动.bat」打开，或手动导入 JSON。');
      return 0;
    });
}

/* ---------- 档位检测弹窗 ---------- */
let detectAns = { energy: null, focus: null, pressure: null };

function detectFormHTML() {
  const q = (key, title, opts) => `
    <div class="q-item">
      <div class="q-title">${title}</div>
      <div class="q-opts" data-q="${key}">
        ${opts.map(([v, label]) => `<button class="opt" data-v="${v}">${label}</button>`).join('')}
      </div>
    </div>`;
  return `
    ${q('energy', '1 · 现在的精力水平？', [['2', '精神饱满'], ['1', '一般'], ['0', '疲惫困倦']])}
    ${q('focus', '2 · 现在的专注状态？', [['2', '能专注'], ['1', '容易分心'], ['0', '完全无法集中']])}
    ${q('pressure', '3 · 现在的压力/紧迫感？', [['2', '焦虑赶时间'], ['1', '适中'], ['0', '很放松']])}
    <button class="btn primary block" id="btnSubmitDetect" disabled>开始检测</button>
  `;
}

function renderDetectResult(gear, note) {
  const sugg = SUGGESTIONS[gear] || [];
  $('#detectModalBody').innerHTML = `
    <div class="result-gear" style="color:var(--accent)">${GEAR_META[gear].name}</div>
    ${note ? `<p class="hint">${escapeHtml(note)}</p>` : ''}
    <ul class="result-list">${sugg.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
  `;
}

function openDetect() {
  detectAns = { energy: null, focus: null, pressure: null };
  $('#detectModalTitle').textContent = '检测我的档位';
  $('#detectModalBody').innerHTML = detectFormHTML();
  $('#detectModal').hidden = false;
}

function openStuck() {
  $('#detectModalTitle').textContent = '我卡住了';
  $('#detectModalBody').innerHTML = `
    <p class="hint">卡住多半是精力耗竭或压力过载。选一条，马上重启：</p>
    <button class="btn primary block" id="btnStuckReset">换轨 · 5 分钟创造性重启</button>
    <button class="btn ghost block" id="btnStuckRest">短休息 15 分钟</button>
  `;
  $('#detectModal').hidden = false;
}

function renderStuckResult(mode) {
  const isReset = mode === 'reset';
  const sugg = isReset ? CREATIVE_RESET : SUGGESTIONS[1];
  $('#detectModalBody').innerHTML = `
    <div class="result-gear">${isReset ? '换轨 · 创造性重启' : '充电 · 短休息'}</div>
    <p class="hint">${isReset ? '去做一件完全不同的小事，让大脑换轨，而不是硬扛。' : '先做一次 15 分钟充电，再回来。'}</p>
    <ul class="result-list">${sugg.slice(0, 3).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
  `;
}

function closeDetect() { $('#detectModal').hidden = true; }

/* ---------- 行为 ---------- */
function saveAll() {
  store.set('settings', settings);
  store.set('tasks', tasks);
  store.set('history', history);
  store.set('sleepLog', sleepLog);
  store.set('daily', daily);
}

// 重建今日排程并刷新。保留仍在未来的「卡住恢复」充电块，其余按当前任务重排。
function reschedule() {
  const now = nowMin();
  const stuck = daily.schedule.filter((e) => STUCK_TITLES.includes(e.title) && e.end > now);
  const r = buildDaySchedule(tasks.filter((t) => !t.done));
  const base = r.schedule.filter((e) => !stuck.some((s) => e.start < s.end && e.end > s.start));
  daily.date = todayStr();
  daily.schedule = mergeSchedule([...base, ...stuck].sort((a, b) => a.start - b.start));
  saveAll();
  render();
}

function applySettingsAndReschedule() {
  settings.wakeTime = $('#wakeTime').value || settings.wakeTime;
  settings.sleepHours = Number($('#sleepHours').value) || settings.sleepHours;
  settings.workRatio = Number($('#workRatio').value);
  $('#workRatioLabel').textContent = settings.workRatio + '%';
  daily.wakeTime = settings.wakeTime;
  daily.sleepHours = settings.sleepHours;
  reschedule();
}

function handleStuck(mode) {
  const now = nowMin();
  const dur = mode === 'reset' ? 20 : 15;
  const title = mode === 'reset' ? '换轨 · 创造性重启' : '充电 · 短休息';
  const sched = daily.schedule;
  const idx = sched.findIndex((e) => now >= e.start && now < e.end);
  if (idx >= 0) {
    sched[idx] = { start: sched[idx].start, end: Math.max(sched[idx].end, now + dur), kind: 'charge', title, gear: 1 };
  } else {
    sched.push({ start: now, end: now + dur, kind: 'charge', title, gear: 1 });
  }
  daily.schedule = mergeSchedule([...sched].sort((a, b) => a.start - b.start));
  saveAll();
  render();
}

function toggleTheme() {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  saveAll();
}
function applyTheme() {
  if (settings.theme === 'dark') document.body.classList.add('dark');
  else document.body.classList.remove('dark');
  $('#btnTheme').textContent = settings.theme === 'dark' ? '☀️' : '🌙';
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}

function showMorningModal() {
  $('#mWakeTime').value = settings.wakeTime;
  $('#mSleepHours').value = settings.sleepHours;
  $('#morningModal').hidden = false;
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ settings, tasks, history, sleepLog, daily }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'brain-gears-backup-' + todayStr() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('#btnDetect').addEventListener('click', openDetect);
  $('#btnStuck').addEventListener('click', openStuck);
  $('#btnDetectClose').addEventListener('click', closeDetect);
  $('#btnTheme').addEventListener('click', toggleTheme);

  // 弹窗内：选项 + 提交（事件委托）
  $('#detectModalBody').addEventListener('click', (ev) => {
    const opt = ev.target.closest('.opt');
    if (opt) {
      const group = opt.parentElement;
      group.querySelectorAll('.opt').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      detectAns[group.dataset.q] = Number(opt.dataset.v);
      const btn = $('#btnSubmitDetect');
      if (btn) btn.disabled = !(detectAns.energy != null && detectAns.focus != null && detectAns.pressure != null);
      return;
    }
    if (ev.target.closest('#btnSubmitDetect')) {
      const gear = detectGear({ ...detectAns });
      history.push({ ts: Date.now(), answers: { ...detectAns }, gear });
      saveAll();
      renderDetectResult(gear, detectNote(detectAns));
      renderBadge();
      renderNow();
      return;
    }
    if (ev.target.closest('#btnStuckReset')) { handleStuck('reset'); renderStuckResult('reset'); renderNow(); return; }
    if (ev.target.closest('#btnStuckRest')) { handleStuck('rest'); renderStuckResult('rest'); renderNow(); return; }
  });

  // tabs
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 任务面板
  $('#btnReloadInbox').addEventListener('click', () => loadInbox(false));
  $('#jsonInput').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const n = importTasksJson(JSON.parse(String(reader.result)));
        reschedule();
        toast('已导入 ' + n + ' 个任务');
      } catch (e) { toast('JSON 解析失败：' + e.message); }
    };
    reader.readAsText(f, 'utf-8');
    ev.target.value = '';
  });
  $('#btnAddTask').addEventListener('click', () => {
    const v = $('#taskInput').value.trim();
    if (!v) return;
    tasks.push(createTask(v, $('#taskType').value, '手动', {
      priority: $('#taskPriority').value,
      load: $('#taskLoad').value,
      estMin: Number($('#taskEstMin').value) || 30
    }));
    $('#taskInput').value = '';
    reschedule();
  });
  $('#taskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnAddTask').click(); });

  // 任务列表（事件委托）
  $('#taskList').addEventListener('click', (ev) => {
    const toggle = ev.target.closest('[data-toggle]');
    const del = ev.target.closest('[data-del]');
    if (toggle) {
      const t = tasks.find((x) => x.id === toggle.dataset.toggle);
      if (t) { t.done = toggle.checked; t.doneAt = toggle.checked ? Date.now() : null; reschedule(); }
    }
    if (del) {
      tasks = tasks.filter((x) => x.id !== del.dataset.del);
      reschedule();
    }
  });

  // 设置
  $('#btnApplySettings').addEventListener('click', applySettingsAndReschedule);
  $('#workRatio').addEventListener('input', (e) => { $('#workRatioLabel').textContent = e.target.value + '%'; });
  $('#btnExport').addEventListener('click', exportBackup);
  $('#btnReset').addEventListener('click', () => {
    if (confirm('清空今日安排与检测历史？（任务保留）')) {
      daily.schedule = []; history = []; saveAll(); render();
    }
  });

  // 早晨流程
  $('#btnMorningOk').addEventListener('click', () => {
    settings.wakeTime = $('#mWakeTime').value || '07:30';
    settings.sleepHours = Number($('#mSleepHours').value) || 7;
    daily.date = todayStr();
    daily.wakeTime = settings.wakeTime;
    daily.sleepHours = settings.sleepHours;
    sleepLog.push({ date: todayStr(), wakeTime: settings.wakeTime, sleepHours: settings.sleepHours });
    daily.schedule = buildDaySchedule(tasks.filter((t) => !t.done)).schedule;
    saveAll();
    $('#morningModal').hidden = true;
    $('#wakeTime').value = settings.wakeTime;
    $('#sleepHours').value = settings.sleepHours;
    render();
  });
  $('#btnMorningSkip').addEventListener('click', () => {
    daily.date = todayStr();
    daily.wakeTime = settings.wakeTime;
    daily.sleepHours = settings.sleepHours;
    daily.schedule = buildDaySchedule(tasks.filter((t) => !t.done)).schedule;
    saveAll();
    $('#morningModal').hidden = true;
    $('#wakeTime').value = settings.wakeTime;
    $('#sleepHours').value = settings.sleepHours;
    render();
  });

  setInterval(() => { renderClock(); renderNow(); renderTimeline(); renderBadge(); }, 60000);
}

/* ---------- 启动 ---------- */
function init() {
  $('#wakeTime').value = settings.wakeTime;
  $('#sleepHours').value = settings.sleepHours;
  $('#workRatio').value = settings.workRatio;
  $('#workRatioLabel').textContent = settings.workRatio + '%';

  applyTheme();
  bindEvents();
  render();

  // 自动导入 inbox（静默，失败不打扰）
  loadInbox(true);

  // 每日首次打开 → 早晨流程
  if (daily.date !== todayStr() || daily.schedule.length === 0) {
    showMorningModal();
  }
}

document.addEventListener('DOMContentLoaded', init);
