// OEE 손실 분석 화면 (프레임워크 없이 순수 JS)

const $ = (s) => document.querySelector(s);
const api = async (path, body) => {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x) => (x == null || Number.isNaN(x) ? '-' : `${Math.round(x * 1000) / 10}%`);
const min = (sec) => `${Math.round(sec / 60).toLocaleString('ko-KR')}분`;
const hrs = (sec) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)}시간` : min(sec));
const won = (x) => (x >= 1e8 ? `${(x / 1e8).toFixed(1)}억 원` : x >= 1e4 ? `${Math.round(x / 1e4).toLocaleString('ko-KR')}만 원` : `${Math.round(x).toLocaleString('ko-KR')}원`);
const clock = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

let CFG = null;
let LIVE = null;
const spark = {}; // 설비별 최근 전류
let currentTab = 'live';
let qQueue = [];
let qActive = null;
let skipped = new Set();
let pendingStopAnswer = null;

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- 공통 그리기 ----------
function kpis(el, total, extra = []) {
  const items = [
    { l: 'OEE (설비종합효율)', v: pct(total.oee), s: '양품 × 이론사이클 ÷ 계획시간', main: true },
    { l: '시간가동률', v: pct(total.availability), s: '고장·셋업·대기 손실' },
    { l: '성능가동률', v: pct(total.performance), s: '순간정지·속도 저하' },
    { l: '양품률', v: pct(total.quality), s: `불량 ${total.defectCount.toLocaleString('ko-KR')}개` },
    { l: '잃어버린 시간', v: hrs(total.totalLossSec), s: `계획 ${hrs(total.plannedSec)} 중` },
    { l: '손실 금액 (추정)', v: won(total.totalLossWon), s: '제품 1개 이익 기준' },
    { l: '사유 응답률', v: total.responseRate == null ? '-' : pct(total.responseRate), s: `${total.answered}/${total.asked}건 답변` },
    ...extra,
  ];
  el.innerHTML = items.map((k) => `<div class="kpi ${k.main ? 'main' : ''}"><div class="l">${k.l}</div><div class="v">${k.v}</div><div class="s">${k.s}</div></div>`).join('');
}

function lossBars(el, total) {
  const entries = Object.entries(total.losses).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.innerHTML = '<p class="muted">아직 손실이 없습니다.</p>'; return; }
  const max = entries[0][1];
  const group = { availability: '가용', performance: '성능', quality: '품질' };
  el.innerHTML = `<div class="bars">${entries.map(([k, v]) => {
    const L = CFG.loss[k];
    return `<div class="row"><div>${L.label} <span class="method">${group[L.group]}</span></div>
      <div class="track"><div class="fill" style="width:${(v / max) * 100}%;background:${L.color}"></div></div>
      <div class="val"><b>${hrs(v)}</b><br><span class="method">${won(total.lossWon[k])}</span></div></div>`;
  }).join('')}</div>`;
}

function timelineBar(tl, untilSec) {
  const { start, end } = CFG.shift;
  const span = end - start;
  const segs = (tl ?? []).map((s) => `<span class="${s.state}" style="left:${((s.start - start) / span) * 100}%;width:${((Math.min(s.end, untilSec ?? end) - s.start) / span) * 100}%" title="${s.state === 'RUN' ? '가동' : s.state === 'STOP' ? '정지' : '점심'} ${clock(s.start)}~${clock(s.end)}"></span>`).join('');
  const ticks = [];
  for (let h = start / 3600; h <= end / 3600; h += 1) ticks.push(`<span>${h}</span>`);
  return `<div class="tl">${segs}</div><div class="tl-axis">${ticks.join('')}</div>`;
}

function lossTag(loss) {
  const L = CFG.loss[loss];
  return `<span class="tag" style="background:${L.color}">${L.label}</span>`;
}

function methodLabel(r) {
  if (!r) return '';
  return { claude: 'Claude 분류', rule: '규칙 분류', button: '버튼 선택' }[r.method] ?? r.method;
}

function stopsTable(stops, { withDate = true, answerable = true } = {}) {
  if (!stops.length) return '<p class="muted">정지 기록이 없습니다.</p>';
  const name = (id) => CFG.machines.find((m) => m.id === id)?.name ?? id;
  return `<div class="scroll"><table><thead><tr>${withDate ? '<th>날짜</th>' : ''}<th>설비</th><th>시각</th><th class="num">시간</th><th>손실 분류</th><th>작업자 답변</th><th></th></tr></thead><tbody>
  ${stops.map((s) => `<tr>${withDate ? `<td>${s.date.slice(5)}</td>` : ''}<td>${esc(name(s.machineId))}</td>
    <td>${s.start == null ? '<span class="muted">작업일보</span>' : `${clock(s.start)}${s.ongoing ? ' <b style="color:var(--stop)">진행 중</b>' : ''}`}</td>
    <td class="num">${Math.round(s.dur / 60)}분</td><td>${lossTag(s.loss)}</td>
    <td>${s.reason?.text ? `“${esc(s.reason.text)}”` : s.reason ? '' : s.text ? `<span class="muted">${esc(s.text)}</span>` : s.hint ? `<span class="muted">신호: ${esc(s.hint)}</span>` : ''}
      ${s.reason ? `<div class="method">${methodLabel(s.reason)}${s.reason.confidence != null && s.reason.method !== 'button' ? ` · 확신 ${Math.round(s.reason.confidence * 100)}%` : ''}${s.reason.summary ? ` · ${esc(s.reason.summary)}` : ''}</div>` : ''}</td>
    <td>${answerable && (!s.reason || !s.reason.code) && s.loss !== 'minor_stop' ? `<button class="ans" data-stop='${esc(JSON.stringify({ machineId: s.machineId, date: s.date, stopId: s.group ?? s.id, start: s.start, hint: s.hint, dur: s.dur, text: s.text }))}'>사유 입력</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button.ans');
  if (!b) return;
  const s = JSON.parse(b.dataset.stop);
  pendingStopAnswer = s;
  openQuestion({ machineId: s.machineId, start: s.start, hint: s.hint, manual: true, dur: s.dur, date: s.date, text: s.text });
});

// ---------- 실시간 ----------
function renderLive() {
  if (!LIVE || !CFG) return;
  $('#liveDate').textContent = `${LIVE.date} (오늘)`;
  $('#liveClock').textContent = LIVE.simSec < CFG.shift.start ? '근무 전' : clock(LIVE.simSec);
  $('#btnStart').disabled = LIVE.running || LIVE.ended;
  $('#btnStart').textContent = LIVE.ended ? '근무 종료' : LIVE.simSec > CFG.shift.start ? '▶ 계속' : '▶ 시작';
  $('#btnPause').disabled = !LIVE.running;
  $('#speed').value = String(LIVE.speed);

  const wrap = $('#liveMachines');
  if (!wrap.children.length) {
    wrap.innerHTML = CFG.machines.filter((m) => m.sim !== false).map((m) => `<div class="mcard" id="mc-${m.id}">
      <div class="mhead"><div class="mname">${esc(m.name)}</div><span class="badge">-</span></div>
      <div class="mbody"><div class="amp">-</div><svg class="spark" viewBox="0 0 120 44" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" stroke-width="1.6" points=""/></svg></div>
      <div class="mstats"></div><div class="mtl"></div></div>`).join('');
  }
  for (const m of LIVE.machines) {
    const el = $(`#mc-${m.id}`);
    const label = { RUN: '가동 중', STOP: `정지 ${Math.floor(m.stopFor / 60)}분째`, BREAK: '점심 (계획정지)', OFF: '근무 전' }[m.state];
    el.className = `mcard ${m.state}`;
    el.querySelector('.badge').className = `badge ${m.state}`;
    el.querySelector('.badge').textContent = label;
    el.querySelector('.amp').innerHTML = `${m.current.toFixed(1)}<small> A</small>`;
    const arr = (spark[m.id] ??= []);
    arr.push(m.current);
    if (arr.length > 120) arr.shift();
    const peak = Math.max(...arr, CFG.machines.find((x) => x.id === m.id).peakCurrentA);
    el.querySelector('polyline').setAttribute('points', arr.map((v, i) => `${(i / 119) * 120},${44 - (v / peak) * 42}`).join(' '));
    el.querySelector('.mstats').innerHTML = `<span>생산 <b>${m.count.toLocaleString('ko-KR')}</b>개</span><span>불량 <b>${m.defects}</b>개</span>`;
    const tl = lastLiveAnalysis?.timelines.find((t) => t.machineId === m.id);
    if (tl) el.querySelector('.mtl').innerHTML = timelineBar(tl.timeline, tl.untilSec);
  }
  // 질문 대기열
  for (const q of LIVE.questions) if (!qQueue.find((x) => x.id === q.id) && !skipped.has(q.id)) qQueue.push(q);
  qQueue = qQueue.filter((q) => LIVE.questions.some((x) => x.id === q.id));
  if (!qActive && qQueue.length && currentTab === 'live') openQuestion(qQueue[0]);
  if (qActive && !qActive.manual && !LIVE.questions.some((x) => x.id === qActive.id)) closeQuestion();
  $('#qCount').textContent = qQueue.length > 1 ? `대기 ${qQueue.length}건` : '';
}

let lastLiveAnalysis = null;
let liveFetchBusy = false;
async function refreshLiveAnalysis() {
  if (liveFetchBusy || currentTab !== 'live') return;
  liveFetchBusy = true;
  try {
    const a = await api('/api/analysis?preset=live');
    lastLiveAnalysis = a;
    kpis($('#liveKpis'), a.total);
    lossBars($('#liveLosses'), a.total);
    $('#liveStops').innerHTML = stopsTable(a.stops.filter((s) => s.loss !== 'minor_stop' || s.dur >= 120).slice(0, 12), { withDate: false });
    renderLive();
  } finally {
    liveFetchBusy = false;
  }
}

$('#btnStart').onclick = () => api('/api/live/start', {}).catch((e) => toast(e.message));
$('#btnPause').onclick = () => api('/api/live/pause', {});
$('#btnReset').onclick = async () => {
  if (!confirm('오늘 실시간 데이터를 지우고 처음부터 다시 시작할까요?')) return;
  qQueue = []; skipped = new Set(); closeQuestion();
  Object.keys(spark).forEach((k) => delete spark[k]);
  await api('/api/live/reset', {});
  refreshLiveAnalysis();
};
$('#speed').onchange = (e) => api('/api/live/settings', { speed: Number(e.target.value) });
// 오늘 결과 바로 보기: 남은 하루를 한 번에 돌리고 정지 사유를 자동으로 채운 뒤 손실 분석(오늘)으로 간다
$('#btnFinish').onclick = async () => {
  const b = $('#btnFinish');
  b.disabled = true; b.textContent = '돌리는 중…';
  try {
    const r = await api('/api/live/finish', {});
    closeQuestion();
    qQueue = [];
    toast(`오늘 하루를 끝까지 돌렸어요 · 정지 사유 ${r.answered}건을 자동으로 채웠어요`);
    $('#aPreset').value = 'live';
    $('#aMachine').value = '';
    document.querySelector('#tabs [data-tab="analysis"]').click();
    scrollTo({ top: 0 });
  } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = '⏭ 오늘 결과 바로 보기'; }
};

// ---------- 질문 창 ----------
function openQuestion(q) {
  qActive = q;
  const m = CFG.machines.find((x) => x.id === q.machineId);
  const when = q.start == null ? '작업일보에 적힌 비가동' : `${clock(q.start)}부터`;
  $('#qText').innerHTML = q.manual
    ? `${esc(m.name)}이(가) ${q.date ?? ''} ${when} ${Math.round((q.dur ?? 0) / 60)}분 멈췄어요.<br>이유를 알려 주세요.`
    : `${esc(m.name)}이(가) ${when} 멈춰 있어요.<br>이유가 뭔가요?`;
  $('#qHint').textContent = [q.hint ? `설비 신호: ${q.hint}` : '', q.text ? `작업일보 기록: ${q.text}` : ''].filter(Boolean).join(' · ');
  $('#qButtons').innerHTML = CFG.reasons.map((r) => `<button data-code="${r.code}">${esc(r.label)}</button>`).join('');
  $('#qInput').value = '';
  $('#qModal').hidden = false;
}
function closeQuestion() {
  qActive = null;
  pendingStopAnswer = null;
  $('#qModal').hidden = true;
}
async function sendAnswer(payload) {
  const q = qActive;
  if (!q) return;
  $('#qSend').disabled = true;
  try {
    let rec;
    if (q.manual) rec = await api('/api/stops/answer', { ...pendingStopAnswer, ...payload });
    else rec = await api('/api/questions/answer', { questionId: q.id, ...payload });
    qQueue = qQueue.filter((x) => x.id !== q.id);
    closeQuestion();
    const label = CFG.reasons.find((r) => r.code === rec.code)?.label;
    toast(payload.text ? `"${payload.text}" → ${label} (${methodLabel(rec)}${rec.llmError ? ', Claude 실패로 규칙 사용' : ''})` : `${label}(으)로 기록했습니다.`);
    if (currentTab === 'analysis') loadAnalysis(); else refreshLiveAnalysis();
    if (drawerAt) openDrawer(drawerAt.date, drawerAt.machine); // 패널에서 사유를 넣었으면 패널도 새로 그린다
    refreshCheckCards().catch(() => {}); // 점검 카드의 "사유 없음"·상태도 다시 센다
  } catch (e) { toast(e.message); } finally { $('#qSend').disabled = false; }
}
$('#qButtons').onclick = (e) => { const b = e.target.closest('button'); if (b) sendAnswer({ code: b.dataset.code }); };
$('#qSend').onclick = () => { const t = $('#qInput').value.trim(); if (t) sendAnswer({ text: t }); };
$('#qInput').onkeydown = (e) => { if (e.key === 'Enter') $('#qSend').click(); };
$('#qLater').onclick = () => { if (qActive && !qActive.manual) skipped.add(qActive.id); qQueue = qQueue.filter((x) => x.id !== qActive?.id); closeQuestion(); };

// 음성 입력 (브라우저 Web Speech API: Chrome·Edge 지원)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$('#qMic').onclick = () => {
  if (!SR) { toast('이 브라우저는 음성 입력을 지원하지 않습니다. Chrome이나 Edge를 쓰거나 글로 적어 주세요.'); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = 'ko-KR';
  rec.interimResults = true;
  $('#qMic').classList.add('rec');
  rec.onresult = (e) => { $('#qInput').value = [...e.results].map((r) => r[0].transcript).join(''); };
  rec.onend = () => { $('#qMic').classList.remove('rec'); rec = null; const t = $('#qInput').value.trim(); if (t) sendAnswer({ text: t }); };
  rec.onerror = (e) => toast(`음성 인식 오류: ${e.error}`);
  rec.start();
};

// ---------- 손실 분석 ----------
// 기간 선택값 → 질의: "range:2025-09-22:2025-12-18" 은 가져온 파일의 기간 그대로
function periodQuery(v) {
  const m = /^range:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(v);
  return m ? `from=${m[1]}&to=${m[2]}` : `preset=${v}`;
}
// 파일을 가져오면 손실 분석·주간 리포트 기간에 "가져온 파일 기간"을 넣고 골라 둔다 (설비가 하나면 설비도)
function usePeriodOfImport(days) {
  if (!days.length) return;
  const dates = days.map((d) => d.date).sort();
  const from = dates[0];
  const to = dates.at(-1);
  const value = `range:${from}:${to}`;
  const label = `가져온 파일 기간 (${from === to ? from : `${from} ~ ${to}`})`;
  for (const id of ['#aPreset', '#rPreset']) {
    const sel = $(id);
    [...sel.options].filter((o) => o.value.startsWith('range:')).forEach((o) => o.remove());
    sel.add(new Option(label, value), 0);
    sel.value = value;
  }
  const machines = [...new Set(days.map((d) => d.machineId))];
  $('#aMachine').value = machines.length === 1 ? machines[0] : '';
}

async function loadAnalysis() {
  const preset = $('#aPreset').value;
  const machine = $('#aMachine').value;
  const a = await api(`/api/analysis?${periodQuery(preset)}&machine=${machine}`);
  $('#aRange').innerHTML = a.total.days ? esc(`${a.range.from} ~ ${a.range.to}`) : '<b class="empty-note">아직 데이터가 없어요 · <a href="#" data-goto="data">데이터 연결</a>에서 예시 파일을 가져오세요</b>';
  kpis($('#aKpis'), a.total);
  lossBars($('#aLosses'), a.total);
  $('#aInsights').innerHTML = a.insights.length ? `<ul class="insights">${a.insights.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('')}</ul>` : '<p class="muted">데이터가 더 쌓이면 패턴을 찾아 드립니다.</p>';

  // 시간대 히트맵
  const rows = a.hourly.rows.filter((r) => r.values.some((v) => v.planned > 0));
  const maxV = Math.max(1, ...rows.flatMap((r) => r.values.map((v) => (v.planned ? v.total / v.planned : 0))));
  $('#aHourly').innerHTML = rows.length ? `<table class="heat"><thead><tr><th>설비</th>${a.hourly.hours.map((h) => `<th>${h}시</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr><td style="text-align:left">${esc(CFG.machines.find((m) => m.id === r.machineId).name)}</td>${r.values.map((v) => {
      if (!v.planned) return '<td class="muted">점심</td>';
      const ratio = v.total / v.planned;
      const alpha = Math.min(1, ratio / maxV);
      return `<td style="background:rgba(217,72,15,${(alpha * 0.85).toFixed(2)});color:${alpha > 0.55 ? '#fff' : 'inherit'}" title="가용 ${Math.round(v.avail)}분 · 성능 ${Math.round(v.perf)}분 / 계획 ${Math.round(v.planned)}분">${Math.round(v.total)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table><div class="legend">칸이 진할수록 그 시간대에 잃은 시간 비율이 큽니다. 작업일보(합계) 데이터는 시간대를 알 수 없어 빠집니다.</div>` : '<p class="muted">시간대 정보가 있는 데이터가 없습니다.</p>';

  lastStops = a.stops;
  renderStops();
  $('#aWarnings').innerHTML = a.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
}
$('#aPreset').onchange = loadAnalysis;
$('#aMachine').onchange = loadAnalysis;

// 정지 기록 정렬 (화면에서만 바꾼다)
let lastStops = [];
const hiddenLoss = new Set(); // 정지 기록에서 숨긴 손실 분류
const LOSS_ORDER = ['breakdown', 'setup', 'waiting', 'other_stop', 'unknown', 'minor_stop', 'speed', 'defect', 'startup'];
const machineOrder = (id) => CFG.machines.findIndex((m) => m.id === id);
function renderStops() {
  const byTime = (x, y) => x.date.localeCompare(y.date) || (x.start ?? Infinity) - (y.start ?? Infinity);
  const sorters = {
    'time-asc': byTime,
    'time-desc': (x, y) => byTime(y, x),
    'dur-desc': (x, y) => y.dur - x.dur || byTime(x, y),
    machine: (x, y) => machineOrder(x.machineId) - machineOrder(y.machineId) || byTime(x, y), // 1·2·3호기 순서
    loss: (x, y) => LOSS_ORDER.indexOf(x.loss) - LOSS_ORDER.indexOf(y.loss) || byTime(x, y),
  };
  renderLossFilter();
  const shown = lastStops.filter((s) => !hiddenLoss.has(s.loss));
  const sorted = shown.sort(sorters[$('#aSort').value] ?? byTime);
  $('#aStops').innerHTML = lastStops.length && !shown.length ? '<p class="muted">선택한 손실 분류에 해당하는 정지가 없습니다.</p>' : stopsTable(sorted);
}

// 정지 기록 손실 분류 필터 (체크를 끈 분류는 표에서 숨긴다)
function renderLossFilter() {
  const counts = {};
  for (const s of lastStops) counts[s.loss] = (counts[s.loss] ?? 0) + 1;
  const present = LOSS_ORDER.filter((k) => counts[k]);
  if (!present.length) { $('#aLossFilter').innerHTML = ''; return; }
  const allOn = present.every((k) => !hiddenLoss.has(k));
  $('#aLossFilter').innerHTML = `<span class="lf-label">손실 분류</span>
    <button type="button" class="lf-all${allOn ? ' on' : ''}" data-all="1">전체</button>
    ${present.map((k) => {
      const L = CFG.loss[k];
      const on = !hiddenLoss.has(k);
      return `<label class="lf-chip${on ? ' on' : ''}" style="--c:${L.color}"><input type="checkbox" data-loss="${k}"${on ? ' checked' : ''}><i></i>${esc(L.label)} <span>${counts[k]}</span></label>`;
    }).join('')}`;
}
$('#aLossFilter').addEventListener('change', (e) => {
  const k = e.target.dataset?.loss;
  if (!k) return;
  if (e.target.checked) hiddenLoss.delete(k); else hiddenLoss.add(k);
  renderStops();
});
$('#aLossFilter').addEventListener('click', (e) => {
  if (!e.target.closest('[data-all]')) return;
  const present = [...new Set(lastStops.map((s) => s.loss))];
  const allOn = present.every((k) => !hiddenLoss.has(k));
  if (allOn) present.forEach((k) => hiddenLoss.add(k)); else hiddenLoss.clear();
  renderStops();
});
$('#aSort').onchange = renderStops;

function sourceLabel(s) {
  return { 'ct-csv': '전류 센서 CSV', mtconnect: 'MTConnect', opcua: 'OPC UA', 'modbus-csv': 'Modbus', 'mes-csv': 'MES 작업일보', 'defects-json': '불량 입력 기록', 'live-ct': '실시간 전류 센서', test: '테스트' }[s] ?? s;
}

// ---------- 리포트 ----------
// ---------- 카톡 리포트 미리보기 (말풍선마다 작은 그래프) ----------
const lossColorByLabel = (label) => Object.values(CFG.loss).find((L) => L.label === label)?.color ?? 'var(--muted)';
const p1 = (x) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
function ktBubble(inner, time = '오전 8:00') {
  return `<div class="kt-msg"><div class="kt-bubble">${inner}</div><span class="kt-time">${time}</span></div>`;
}
function renderKakao(f, trend, empty) {
  if (empty) {
    $('#ktDate').textContent = '';
    $('#ktChat').innerHTML = `<div class="kt-day">매주 월요일 오전 8시 자동 발송</div>
      <div class="kt-from"><span class="kt-avatar">🏭</span><b>OEE 리포트봇</b></div>
      ${ktBubble('<div class="kt-title">아직 보낼 리포트가 없어요</div>데이터 연결 탭에서 예시 파일(하루치 · 일주일치)을 가져오면 이곳에 그래프 리포트가 만들어져요.<button type="button" class="kt-btn" data-goto="data">데이터 연결로 가기</button>')}`;
    return;
  }
  const md = (d) => d.slice(5).replace('-', '/');
  $('#ktDate').textContent = `${md(f.period.from)} ~ ${md(f.period.to)}`;
  const diff = f.previousOEE != null ? (f.factoryOEE - f.previousOEE) * 100 : null;
  const delta = diff == null ? '' : `<span class="kt-delta ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)}%p <small>지난 기간 대비</small></span>`;
  const tone = f.factoryOEE >= 0.75 ? 'good' : f.factoryOEE >= 0.6 ? 'mid' : 'bad';
  const lossTotal = Object.values(f.lossHours).reduce((a, b) => a + b, 0);
  const top = Object.entries(f.lossHours).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const meter = (label, v) => `<div class="kt-meter"><span>${label}</span><i><b style="width:${Math.min(100, v * 100)}%"></b></i><em>${p1(v)}</em></div>`;

  const b1 = `<div class="kt-title">📊 주간 설비 리포트</div>
    <div class="kt-hero"><span class="kt-oee ${tone}">${p1(f.factoryOEE)}</span><span class="kt-hero-l">공장 전체 OEE${delta}</span></div>
    <div class="kt-gauge" title="세계 수준 85%"><b class="${tone}" style="width:${Math.min(100, f.factoryOEE * 100)}%"></b><i style="left:85%"></i></div>
    <div class="kt-gauge-x"><span>0</span><span>목표 85%</span></div>
    ${meter('시간가동률', f.availability)}${meter('성능가동률', f.performance)}${meter('양품률', f.quality)}`;
  const b2 = `<div class="kt-title">💸 잃어버린 시간 <b>${lossTotal.toFixed(1)}시간</b></div>
    <div class="kt-sub">약 <b>${won(f.lossWon)}</b> · 사유 응답률 ${f.responseRate != null ? p1(f.responseRate) : '-'}</div>
    ${top.map(([label, h], i) => `<div class="kt-loss"><span class="kt-rank">${i + 1}</span><span class="kt-lname">${esc(label)}</span><i><b style="width:${(h / top[0][1]) * 100}%;background:${lossColorByLabel(label)}"></b></i><em>${h.toFixed(1)}h</em></div>`).join('')}`;
  const b3 = `<div class="kt-title">🏭 설비별 OEE</div>
    ${f.machines.map((m) => {
      const worst = Object.entries(m.lossHours).sort((a, b) => b[1] - a[1])[0];
      const t = m.oee >= 0.75 ? 'good' : m.oee >= 0.6 ? 'mid' : 'bad';
      return `<div class="kt-mach"><div class="kt-mach-h"><span>${esc(m.name)}</span><b class="${t}">${p1(m.oee)}</b></div>
        <i class="kt-bar"><b class="${t}" style="width:${m.oee * 100}%"></b></i>
        ${worst && worst[1] > 0 ? `<div class="kt-mach-s">가장 큰 손실 <span style="color:${lossColorByLabel(worst[0])}">●</span> ${esc(worst[0])} ${worst[1].toFixed(1)}시간</div>` : ''}</div>`;
    }).join('')}`;
  const b4 = trend.length > 1 ? `<div class="kt-title">📅 날짜별 OEE</div>
    <div class="kt-cols">${trend.map((t) => `<div title="${t.date} · ${p1(t.oee)}"><em>${Math.round(t.oee * 100)}</em><i><b style="height:${t.oee * 100}%"></b></i><span>${t.weekday}</span></div>`).join('')}</div>` : '';
  const b5 = f.insights.length ? `<div class="kt-title">💡 이번 주 할 일</div>
    <ol class="kt-todo">${f.insights.slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
    <button type="button" class="kt-btn" id="ktMore">손실 분석 자세히 보기</button>` : '';
  $('#ktChat').innerHTML = `<div class="kt-day">매주 월요일 오전 8시 자동 발송</div>
    <div class="kt-from"><span class="kt-avatar">🏭</span><b>OEE 리포트봇</b></div>
    ${[b1, b2, b3, b4, b5].filter(Boolean).map((b, i, arr) => ktBubble(b, i === arr.length - 1 ? '오전 8:00' : '')).join('')}`;
  const more = $('#ktMore');
  if (more) more.onclick = () => document.querySelector('#tabs [data-tab="analysis"]').click();
}

async function loadReport() {
  const preset = $('#rPreset').value;
  const [r, a] = await Promise.all([api(`/api/report?${periodQuery(preset)}`), api(`/api/analysis?${periodQuery(preset)}`)]);
  $('#rText').textContent = r.text;
  renderKakao(r.facts, a.trend, !a.total.days);
}
$('#rPreset').onchange = loadReport;
$('#btnCopy').onclick = async () => { await navigator.clipboard.writeText($('#rText').textContent); toast('리포트를 복사했습니다.'); };

// ---------- 데이터 연결 ----------
const REAL_DATA = [
  { name: 'KAMP 인공지능 제조 플랫폼 · 제조 AI 데이터셋', url: 'https://www.kamp-ai.kr/aidataList', note: '중기부 운영. CNC 머신, 사출성형기, 프레스기, 용접기 등 50종 무료 (회원가입 후 다운로드). 국내 중소 공장 실데이터에 가장 가깝습니다.' },
  { name: 'KAMP 제조데이터 라이브러리', url: 'https://mdata.kamp-ai.kr/', note: '업종별(사출·주조·정밀가공 등) 제조 데이터 상품 목록' },
  { name: '공공데이터포털 · 제조AI 데이터셋 50종 목록', url: 'https://www.data.go.kr/data/15089213/fileData.do', note: 'KAMP 데이터셋의 업종·목적·다운로드 링크를 CSV 한 장으로 정리 (로그인 없이 다운로드)' },
  { name: 'AI Hub · 기계시설물 고장 예지 센서', url: 'https://aihub.or.kr/aihubdata/data/view.do?aihubDataSe=&currMenu=115&dataSetSn=238&topMenu=100', note: '전동기 진동·전류 233만 건 (정상 / 베어링 불량 / 불평형 / 축정렬 불량 / 벨트 느슨함). 내국인 신청 필요' },
  { name: 'AI Hub · SMT 공정 개선 멀티모달 데이터', url: 'https://aihub.or.kr/aihubdata/data/view.do?aihubDataSe=data&currMenu=115&dataSetSn=71900&topMenu=100', note: '전자부품(구미) SMT 공정 센서 + 검사 이미지' },
  { name: 'MTConnect 공식 Agent', url: 'https://www.mtconnect.org/', note: 'docker run -p 5000:5000 mtconnect/agent 로 CNC 데모 데이터를 실시간으로 받아 볼 수 있습니다. 이 서비스의 MTConnect 가져오기와 같은 XML 형식' },
  { name: 'UCI · MetroPT-3 (압축기 모터 전류·압력)', url: 'https://archive.ics.uci.edu/dataset/791/metropt+3+dataset', note: '실제 운행 중 압축기의 1초 단위 센서 15종 + 고장 기록. 전류 기반 가동 판정 연습용' },
  { name: 'UCI · AI4I 2020 Predictive Maintenance', url: 'https://archive.ics.uci.edu/dataset/601/ai4i+2020+predictive+maintenance+dataset', note: '공구 마모·과부하 등 고장 유형 라벨이 있는 합성 데이터 1만 건' },
  { name: 'CWRU 베어링 데이터 센터', url: 'https://engineering.case.edu/bearingdatacenter', note: '진동 기반 고장 진단(2단계 기능)의 표준 벤치마크' },
];

// ---------- 예시 파일 (하루치 · 일주일치 / 보기 · 저장 · 가져오기) ----------
let exFiles = [];
let exRange = '1d';
let exInfo = null;
function fmtSize(n) {
  if (n == null) return '';
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}
const EX_TITLE = {
  'ct-csv': '전류 센서 로그', mtconnect: 'CNC 가동 기록', opcua: '사출기 가동 기록',
  'modbus-csv': 'PLC 신호 로그', 'mes-csv': 'MES 작업일보', 'defects-json': '작업자 불량 입력',
};
const exTitle = (f) => EX_TITLE[f.format] ?? f.file;
const sampleUrl = (f) => `/samples/set/${exRange}/${f.key}`;
function renderExamples() {
  const FILE_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>';
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  const md = (d) => d.slice(5).replace('-', '/');
  $('#exDate').textContent = exInfo ? (exInfo.days === 1 ? exInfo.from : `${md(exInfo.from)} ~ ${md(exInfo.to)} · 평일 ${exInfo.days}일`) : '';
  document.querySelectorAll('#exRange button').forEach((b) => b.classList.toggle('on', b.dataset.range === exRange));
  $('#exList').innerHTML = exFiles.map((f, i) => `<tr class="${f.core ? '' : 'ex-extra'}">
      <td><span class="ex-name">${FILE_ICO}<b>${esc(exTitle(f))}</b><span>${esc(f.who)}</span>${f.core ? '' : '<em class="ex-tag" title="같은 설비·날짜를 다른 형식으로 담은 파일이에요. 가져오면 앞의 기록을 덮어써서 \'전부 가져오기\'에는 넣지 않아요.">다른 형식</em>'}</span></td>
      <td class="muted">${esc(sourceLabel(f.format))}</td>
      <td class="num muted">${fmtSize(f.size)}</td>
      <td class="ex-act"><button type="button" class="icon-btn" data-view="${i}" title="내용 보기" aria-label="${esc(exTitle(f))} 내용 보기">${EYE}</button><a class="icon-btn" href="${sampleUrl(f)}" download="${esc(f.file)}" title="저장" aria-label="${esc(exTitle(f))} 저장">${DOWN}</a></td>
    </tr>`).join('');
}
async function loadExamples() {
  exInfo = await api(`/api/samples?range=${exRange}`);
  exFiles = exInfo.files;
  renderExamples();
}
$('#exRange').onclick = (e) => {
  const b = e.target.closest('[data-range]');
  if (!b || b.dataset.range === exRange) return;
  exRange = b.dataset.range;
  $('#exList').innerHTML = '<tr><td colspan="4" class="muted">만드는 중…</td></tr>';
  loadExamples().catch((er) => toast(er.message));
};
$('#exList').onclick = async (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  const f = exFiles[+b.dataset.view];
  const p = await api(`${sampleUrl(f)}?preview=1`);
  $('#vTitle').textContent = exTitle(f);
  $('#vMeta').textContent = `${f.file} · ${fmtSize(f.size)} · ${p.lines.toLocaleString('ko-KR')}줄${p.lines > 60 ? ' (앞 60줄만 보여 줍니다)' : ''}`;
  $('#vBody').textContent = p.head;
  $('#vSave').href = sampleUrl(f);
  $('#vSave').setAttribute('download', f.file);
  $('#viewer').hidden = false;
};
const closeViewer = () => { $('#viewer').hidden = true; };
$('#vClose').onclick = closeViewer;
$('#viewer').onclick = (e) => { if (e.target.id === 'viewer') closeViewer(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer(); });
// 전부 가져오기: 설비·날짜가 겹치지 않는 파일만 (전류 · CNC · 사출기 · 불량), 서버에서 바로 가져온다
$('#exImportAll').onclick = async () => {
  const btn = $('#exImportAll');
  btn.disabled = true; btn.textContent = '가져오는 중…';
  const range = exRange;
  try {
    await importFiles(exFiles.filter((f) => f.core).map((f) => ({ name: f.file, label: exTitle(f), run: () => api('/api/samples/import', { range, key: f.key }) })));
  } finally { btn.disabled = false; btn.textContent = '전부 가져오기'; }
};

// 파일 여러 개를 차례로 가져오고 결과를 보여 준다 (샘플·내 파일 공통)
const CK_STATUS = {
  action: { label: '조치 필요', cls: 'action' },
  review: { label: '검토 필요', cls: 'review' },
  ok: { label: '정상', cls: 'ok' },
  done: { label: '조치 완료', cls: 'done' },
  error: { label: '읽기 실패', cls: 'action' },
};
const machineName = (id) => CFG.machines.find((m) => m.id === id)?.name ?? id;

// 점검 결과 카드 한 장 (파일 하나)
const oeeTone = (x) => (x >= 0.75 ? 'good' : x >= 0.6 ? 'mid' : 'bad');
const ckMin = (sec) => `${Math.round(sec / 60).toLocaleString('ko-KR')}분`;
// 설비·날짜 한 줄
function ckRow(d) {
  return `<div class="ck-row" data-date="${esc(d.date)}" data-machine="${esc(d.machineId)}">
      <div class="ck-who"><b>${esc(d.machineName)}</b><span>${esc(d.date)}</span></div>
      <div class="ck-nums">
        <span class="ck-oee ${oeeTone(d.oee)}"><em>OEE</em><b>${pct(d.oee)}</b></span>
        <span><em>정지</em><b>${d.stops}건</b></span>
        <span><em>사유 없음</em><b data-unknown class="${d.unknown ? 'hot' : ''}">${d.unknown}건</b></span>
        <span class="ck-top"><em>가장 큰 손실</em>${d.topLoss ? `${lossTag(d.topLoss.loss)} <b>${hrs(d.topLoss.sec)}</b>` : '<b>-</b>'}</span>
      </div>
      <button type="button" class="ck-go" data-date="${esc(d.date)}" data-machine="${esc(d.machineId)}" title="이 설비·날짜만 오른쪽에서 보기">분석 보기 →</button>
    </div>`;
}
// 여러 날짜가 든 파일: 요약 한 줄 + 날짜별 OEE 막대 + OEE가 낮은 3일, 나머지는 접어 둔다
function ckSummary(items) {
  const dates = [...new Set(items.map((d) => d.date))].sort();
  const machines = [...new Set(items.map((d) => d.machineId))];
  const avg = items.reduce((a, d) => a + d.oee, 0) / items.length;
  const stops = items.reduce((a, d) => a + d.stops, 0);
  const unknown = items.reduce((a, d) => a + d.unknown, 0);
  const losses = {};
  for (const d of items) for (const [k, v] of Object.entries(d.losses ?? {})) losses[k] = (losses[k] ?? 0) + v;
  const top = Object.entries(losses).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
  const byDate = dates.map((date) => {
    const ds = items.filter((d) => d.date === date);
    return { date, oee: ds.reduce((a, d) => a + d.oee, 0) / ds.length, machine: ds.length === 1 ? ds[0].machineId : '' };
  });
  const worst = [...items].sort((a, b) => a.oee - b.oee).slice(0, 3);
  return `<div class="ck-summary">
      <div class="ck-who"><b>${machines.length === 1 ? esc(items[0].machineName) : `설비 ${machines.length}대`}</b><span>${esc(dates[0])} ~ ${esc(dates.at(-1))} · ${dates.length}일</span></div>
      <div class="ck-nums">
        <span class="ck-oee ${oeeTone(avg)}"><em>하루 평균 OEE</em><b>${pct(avg)}</b></span>
        <span><em>정지</em><b>${stops.toLocaleString('ko-KR')}건</b></span>
        <span><em>사유 없음</em><b data-sum-unknown class="${unknown ? 'hot' : ''}">${unknown}건</b></span>
        <span class="ck-top"><em>가장 큰 손실</em>${top ? `${lossTag(top[0])} <b>${hrs(top[1])}</b>` : '<b>-</b>'}</span>
      </div>
    </div>
    <div class="ck-spark" aria-label="날짜별 OEE">${byDate.map((b) => `<button type="button" class="ck-bar ${oeeTone(b.oee)}" ${b.machine ? `data-date="${esc(b.date)}" data-machine="${esc(b.machine)}"` : 'disabled'} title="${esc(b.date)} · OEE ${pct(b.oee)}${b.machine ? ' · 눌러서 분석 보기' : ''}"><i style="height:${Math.max(4, Math.min(100, b.oee * 100))}%"></i></button>`).join('')}</div>
    <div class="ck-spark-x"><span>${esc(dates[0])}</span><span>막대: 날짜별 OEE · 낮을수록 빨강</span><span>${esc(dates.at(-1))}</span></div>
    <div class="ck-sub">OEE가 낮은 날</div>
    ${worst.map(ckRow).join('')}
    <details class="ck-days"><summary>날짜별 전체 보기 (${items.length})</summary>${items.map(ckRow).join('')}</details>`;
}

function checkCard(it, r, err) {
  const st = CK_STATUS[err ? 'error' : r.check.status];
  const head = `<summary class="ck-head">
    <span class="ck-file"><b>${esc(it.label ?? it.name)}</b></span>
    <span class="ck-badge ${st.cls}">${st.label}</span></summary>`;
  if (err) {
    return `<details class="ck ${st.cls}" data-status="error">${head}<div class="ck-body"><ul class="ck-issues"><li class="action">${esc(err.message)}</li></ul>
      <div class="ck-todo"><span>먼저 할 일</span>지원하는 형식(CSV · XML · JSON)인지, 파일이 잘리지 않았는지 확인</div></div></details>`;
  }
  const c = r.check;
  let body = '';
  let issues = [];
  if (c.kind === 'defects') {
    body = `<div class="ck-row"><div class="ck-who">작업자 불량 기록</div><div class="ck-nums"><span><em>불량 입력</em><b>${c.defects}건</b></span><span><em>연결된 기록</em><b>${c.attached}건</b></span></div></div>`;
    issues = c.issues;
  } else if (new Set(c.items.map((d) => d.date)).size > 1) {
    body = ckSummary(c.items);
    // 같은 내용은 한 번만: 사유 없는 정지는 합계로, 경고는 해당 일수와 함께
    // 설비가 여럿이면 "설비·날짜" 단위라 '곳', 하나면 '일'
    const unit = new Set(c.items.map((d) => d.machineId)).size > 1 ? '곳' : '일';
    const un = c.items.filter((d) => d.unknown);
    if (un.length) {
      issues.push({ level: 'action', total: true, text: `사유가 빈 정지 ${un.reduce((a, d) => a + d.unknown, 0)}건 (합계 ${ckMin(un.reduce((a, d) => a + (d.unknownSec ?? 0), 0))}, ${un.length}${unit})`, todo: '정지 기록에서 사유 입력' });
    }
    const warn = new Map();
    for (const d of c.items) for (const i of d.issues) if (!i.todo) warn.set(i.text, (warn.get(i.text) ?? 0) + 1);
    for (const [text, n] of warn) issues.push({ level: 'review', text: n > 1 ? `${text} (${n === c.items.length ? '전체 해당' : `${n}${unit}`})` : text });
  } else {
    body = c.items.map(ckRow).join('');
    issues = c.items.flatMap((d) => d.issues.map((i) => ({ ...i, key: i.todo ? `${d.machineId}|${d.date}` : '', who: c.items.length > 1 ? d.machineName : '' })));
  }
  const todo = issues.find((i) => i.todo);
  return `<details class="ck ${st.cls}" data-status="${c.status}">${head}<div class="ck-body">${body}
    ${issues.length ? `<ul class="ck-issues">${issues.map((i) => `<li class="${i.level}"${i.key ? ` data-unknown-for="${esc(i.key)}"` : ''}${i.total ? ' data-unknown-total' : ''}>${i.who ? `<b>${esc(i.who)}</b> · ` : ''}<span>${esc(i.text)}</span></li>`).join('')}</ul>` : '<p class="ck-fine">문제없이 읽었어요. 바로 분석에 쓸 수 있습니다.</p>'}
    ${todo ? `<div class="ck-todo"><span>먼저 할 일</span>${esc(todo.todo)}</div>` : ''}
  </div></details>`;
}

// 파일 여러 개를 차례로 가져오고 점검 결과를 보여 준다 (예시·내 파일 공통)
async function importFiles(items) {
  const cards = [];
  const importedDays = [];
  $('#uploadResult').innerHTML = `<div class="ck-sum"><b>점검 중…</b> 파일 ${items.length}개</div>`;
  for (const it of items) {
    try {
      const r = it.run ? await it.run() : await api('/api/import', { filename: it.name, content: await it.read(), format: it.format ?? 'auto' });
      importedDays.push(...r.imported);
      cards.push(checkCard(it, r));
    } catch (e) {
      cards.push(checkCard(it, null, e));
    }
  }
  $('#uploadResult').innerHTML = `<div class="ck-sum" id="ckSum"></div><div class="ck-list">${cards.join('')}</div>`;
  renderCkSummary();
  usePeriodOfImport(importedDays);
  $('#uploadResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const cfg = await api('/api/config');
  CFG.dates = cfg.dates;
  loadData();
}

// "데이터 연결로 가기" 같은 안내 링크
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (!g) return;
  e.preventDefault();
  document.querySelector(`#tabs [data-tab="${g.dataset.goto}"]`).click();
  scrollTo({ top: 0 });
});
$('#homeLogo').onclick = () => document.querySelector('#tabs [data-tab="live"]').click();

// 점검 결과 맨 위 요약 (카드 상태를 세어서 그린다 — 사유를 채우면 바로 바뀐다)
function renderCkSummary() {
  const el = $('#ckSum');
  if (!el) return;
  const cards = [...document.querySelectorAll('.ck-list .ck')];
  const n = (st) => cards.filter((c) => st.includes(c.dataset.status)).length;
  const parts = [['action', ['action', 'error'], '조치 필요'], ['done', ['done'], '조치 완료'], ['review', ['review'], '검토 필요'], ['ok', ['ok'], '정상']];
  el.innerHTML = `<b>점검 결과</b><span>파일 ${cards.length}개</span>${parts.map(([cls, st, label]) => (n(st) ? `<span class="ck-badge ${cls}">${label} ${n(st)}</span>` : '')).join('')}`;
}

// 사유를 입력한 뒤: 사유가 비어 있던 카드의 숫자를 다시 세고, 다 채웠으면 "조치 완료"로 바꾼다
// 카드 하나당 한 번만 묻는다 (여러 날짜 파일도 기간 전체를 한 번에)
async function refreshCheckCards() {
  const cards = [...document.querySelectorAll('.ck-list .ck[data-status="action"], .ck-list .ck[data-status="done"]')];
  for (const card of cards) {
    const rows = [...card.querySelectorAll('.ck-row[data-machine]')];
    if (!rows.length) continue;
    const dates = rows.map((r) => r.dataset.date).sort();
    const machines = [...new Set(rows.map((r) => r.dataset.machine))];
    const a = await api(`/api/analysis?from=${dates[0]}&to=${dates.at(-1)}${machines.length === 1 ? `&machine=${machines[0]}` : ''}`);
    const keys = new Set(rows.map((r) => `${r.dataset.machine}|${r.dataset.date}`));
    const un = new Map();
    for (const x of a.stops) {
      const k = `${x.machineId}|${x.date}`;
      if (!keys.has(k) || x.loss !== 'unknown') continue;
      const v = un.get(k) ?? { n: 0, sec: 0 };
      v.n++; v.sec += x.dur;
      un.set(k, v);
    }
    for (const row of rows) {
      const k = `${row.dataset.machine}|${row.dataset.date}`;
      const n = un.get(k)?.n ?? 0;
      const b = row.querySelector('[data-unknown]');
      b.textContent = `${n}건`;
      b.classList.toggle('hot', n > 0);
    }
    for (const li of card.querySelectorAll('li[data-unknown-for]')) {
      const v = un.get(li.dataset.unknownFor);
      if (v) li.querySelector('span').textContent = `사유가 빈 정지 ${v.n}건 (합계 ${ckMin(v.sec)})`;
      else li.remove();
    }
    const left = [...un.values()].reduce((t, v) => t + v.n, 0);
    const total = card.querySelector('li[data-unknown-total]');
    if (total && left) total.querySelector('span').textContent = `사유가 빈 정지 ${left}건 (합계 ${ckMin([...un.values()].reduce((t, v) => t + v.sec, 0))}, ${un.size}${machines.length > 1 ? '곳' : '일'})`;
    else if (total) total.remove();
    const sum = card.querySelector('[data-sum-unknown]');
    if (sum) { sum.textContent = `${left}건`; sum.classList.toggle('hot', left > 0); }
    const done = left === 0;
    card.dataset.status = done ? 'done' : 'action';
    card.classList.toggle('done', done);
    card.classList.toggle('action', !done);
    const badge = card.querySelector('.ck-head .ck-badge');
    badge.className = `ck-badge ${done ? 'done' : 'action'}`;
    badge.textContent = done ? '조치 완료' : '조치 필요';
    const todo = card.querySelector('.ck-todo');
    if (todo) todo.hidden = done;
    let fine = card.querySelector('.ck-fine.done');
    if (done && !fine) {
      fine = document.createElement('p');
      fine.className = 'ck-fine done';
      fine.textContent = '사유를 모두 입력했어요. 이제 손실 원인이 정확히 집계됩니다.';
      card.querySelector('.ck-body').append(fine);
    } else if (!done && fine) fine.remove();
  }
  renderCkSummary();
}

// 점검 결과에서 "분석 보기" → 오른쪽 패널에 그 설비·날짜 분석을 띄운다 (탭은 그대로)
let drawerAt = null;
async function openDrawer(date, machine) {
  drawerAt = { date, machine };
  const a = await api(`/api/analysis?from=${date}&to=${date}&machine=${machine}`);
  const t = a.total;
  $('#dTitle').textContent = machineName(machine);
  $('#dSub').textContent = `${date} · 계획 ${hrs(t.plannedSec)} 중 ${hrs(t.totalLossSec)} 손실`;
  const tone = t.oee >= 0.75 ? 'good' : t.oee >= 0.6 ? 'mid' : 'bad';
  $('#dKpis').innerHTML = `<div class="d-oee ${tone}"><em>OEE</em><b>${pct(t.oee)}</b></div>
    <div><em>시간가동률</em><b>${pct(t.availability)}</b></div>
    <div><em>성능가동률</em><b>${pct(t.performance)}</b></div>
    <div><em>양품률</em><b>${pct(t.quality)}</b></div>
    <div><em>손실 금액</em><b>${won(t.totalLossWon)}</b></div>`;
  const tl = a.timelines[0];
  $('#dTl').innerHTML = tl?.timeline?.length ? timelineBar(tl.timeline, tl.untilSec) : '<p class="muted">시각 정보가 없는 데이터예요 (작업일보 합계).</p>';
  lossBars($('#dLosses'), t);
  // 사유를 모두 채웠으면 손실 순위 1위(가장 큰 손실)에만 "조치 완료" 배지를 단다
  if (a.stops.length && !a.stops.some((x) => x.loss === 'unknown')) {
    const top = $('#dLosses .bars .row');
    top?.classList.add('lb-top');
    top?.firstElementChild.insertAdjacentHTML('beforeend', '<span class="ck-badge done lb-done">조치 완료</span>');
  }
  const stops = [...a.stops].sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity));
  $('#dStops').innerHTML = stopsTable(stops, { withDate: false });
  document.body.classList.add('drawer-open');
  $('#drawer').removeAttribute('inert');
  $('#drawer').setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  drawerAt = null;
  document.body.classList.remove('drawer-open');
  $('#drawer').setAttribute('inert', '');
  $('#drawer').setAttribute('aria-hidden', 'true');
}
$('#dClose').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerAt && $('#qModal').hidden) closeDrawer(); });
$('#uploadResult').onclick = (e) => {
  const b = e.target.closest('.ck-go, .ck-bar[data-machine]');
  if (!b) return;
  openDrawer(b.dataset.date, b.dataset.machine).catch((er) => toast(er.message));
};

// 내 파일: 끌어다 놓기 또는 눌러서 고르기
// 파일 글자 읽기: UTF-8이 아니면 한국 엑셀이 저장하는 EUC-KR(CP949)로 다시 읽는다
async function readFileText(f) {
  const buf = await f.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('euc-kr').decode(buf);
  }
}
const fromFiles = (list) => [...list].map((f) => ({ name: f.name, read: () => readFileText(f) }));
$('#file').onchange = () => { if ($('#file').files.length) importFiles(fromFiles($('#file').files)).finally(() => { $('#file').value = ''; }); };
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
dz.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles(fromFiles(e.dataTransfer.files)); });

async function loadData() {
  await loadExamples();
  const imp = await api('/api/imports');
  $('#impCount').textContent = imp.length ? `${imp.length}건` : '';
  $('#imports').innerHTML = imp.length ? `<ul class="imp-list">${imp.slice(0, 8).map((i) => `<li><span class="ftype">${esc(sourceLabel(i.format))}</span><b>${esc(i.file)}</b><span class="muted">${[i.days ? `${i.days}개 설비·일` : '', i.defects ? `불량 ${i.defects}` : ''].filter(Boolean).join(' · ')}</span><time>${new Date(i.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></li>`).join('')}</ul>${imp.length > 8 ? `<p class="hint">최근 8건만 보여 줍니다 (전체 ${imp.length}건).</p>` : ''}` : '<p class="muted">아직 가져온 파일이 없습니다.</p>';
  $('#realData').innerHTML = REAL_DATA.map((d) => `<li><a href="${d.url}" target="_blank" rel="noopener" title="${esc(d.note)}">${esc(d.name)}</a></li>`).join('');
}
$('#btnClear').onclick = async () => {
  if (!confirm('가져온 파일, 입력한 사유, 오늘 실시간 기록까지 모두 지울까요? 되돌릴 수 없어요.')) return;
  await api('/api/data/clear', {});
  $('#uploadResult').innerHTML = '';
  toast('모든 데이터를 지웠어요. 예시 파일을 다시 가져와 보세요.');
  const cfg = await api('/api/config');
  CFG.dates = cfg.dates;
  loadData();
};

// ---------- 탭 · 시작 ----------
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  currentTab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${currentTab}`));
  if (currentTab === 'live') refreshLiveAnalysis();
  if (currentTab === 'analysis') loadAnalysis().catch((er) => toast(er.message));
  if (currentTab === 'report') loadReport().catch((er) => toast(er.message));
  if (currentTab === 'data') loadData().catch((er) => toast(er.message));
};

async function init() {
  CFG = await api('/api/config');
  $('#aMachine').innerHTML += CFG.machines.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  LIVE = await api('/api/live');
  renderLive();
  refreshLiveAnalysis();
  const es = new EventSource('/api/events');
  es.addEventListener('live', (e) => { LIVE = JSON.parse(e.data); renderLive(); });
  setInterval(() => { if (LIVE?.running) refreshLiveAnalysis(); }, 1000);
}
init().catch((e) => toast(`서버에 연결하지 못했습니다: ${e.message}`, 8000));
