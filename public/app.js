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
  $('#autoAnswer').checked = LIVE.autoAnswer;

  const wrap = $('#liveMachines');
  if (!wrap.children.length) {
    wrap.innerHTML = CFG.machines.map((m) => `<div class="mcard" id="mc-${m.id}">
      <div class="mhead"><div class="mname">${esc(m.name)}</div><span class="badge">-</span></div>
      <div class="mbody"><div class="amp">-</div><svg class="spark" viewBox="0 0 120 44" preserveAspectRatio="none"><polyline fill="none" stroke="#1f5fbf" stroke-width="1.4" points=""/></svg></div>
      <div class="mstats"></div><div class="mtl"></div>
      <div class="mactions">
        <button data-defect="${m.id}">불량 +1</button>
        <select data-inject-code="${m.id}">
          <option value="SETUP|12">금형·공구 교체 12분</option><option value="BREAKDOWN|25">고장 25분</option>
          <option value="MATERIAL|10">자재 대기 10분</option><option value="JAM|3">걸림 3분</option>
        </select>
        <button data-inject="${m.id}">지금 멈추기</button>
      </div></div>`).join('');
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
    const r = lastLiveAnalysis?.days.find((d) => d.machineId === m.id);
    el.querySelector('.mstats').innerHTML = `<span>생산 <b>${m.count.toLocaleString('ko-KR')}</b>개</span><span>불량 <b>${m.defects}</b>개</span>${r ? `<span>OEE <b>${pct(r.oee)}</b></span>` : ''}<span>전류 센서(CT)</span>`;
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

$('#liveMachines').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-defect]');
  const inj = e.target.closest('[data-inject]');
  try {
    if (d) { await api('/api/live/defect', { machineId: d.dataset.defect }); toast('불량 1개를 기록했습니다.'); }
    if (inj) {
      const [code, minutes] = $(`[data-inject-code="${inj.dataset.inject}"]`).value.split('|');
      await api('/api/live/inject', { machineId: inj.dataset.inject, code, minutes: Number(minutes) });
      toast(`지금부터 ${minutes}분 멈춥니다. 2분이 지나면 작업자에게 질문이 갑니다.`);
      if (!LIVE.running) await api('/api/live/start', {});
    }
  } catch (err) { toast(err.message); }
});

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
$('#autoAnswer').onchange = (e) => api('/api/live/settings', { autoAnswer: e.target.checked });

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
async function loadAnalysis() {
  const preset = $('#aPreset').value;
  const machine = $('#aMachine').value;
  const a = await api(`/api/analysis?preset=${preset}&machine=${machine}`);
  $('#aRange').textContent = `${a.range.from} ~ ${a.range.to} · 데이터 출처: ${a.sources.map(sourceLabel).join(', ')}`;
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

  // 설비 비교
  $('#aMachines').innerHTML = `<table><thead><tr><th>설비</th><th class="num">OEE</th><th>가장 큰 손실</th><th class="num">고장</th><th class="num">MTTR</th><th class="num">MTBF</th><th class="num">셋업 평균</th></tr></thead><tbody>
    ${a.machines.filter((m) => m.days).map((m) => `<tr><td>${esc(m.name)}</td><td class="num"><b>${pct(m.agg.oee)}</b></td><td>${m.topLoss && m.topLoss[1] > 0 ? `${lossTag(m.topLoss[0])} ${hrs(m.topLoss[1])}` : '-'}</td>
    <td class="num">${m.breakdowns}회</td><td class="num">${m.mttrMin ? `${Math.round(m.mttrMin)}분` : '-'}</td><td class="num">${m.mtbfHours ? `${m.mtbfHours.toFixed(1)}h` : '-'}</td><td class="num">${m.avgSetupMin ? `${Math.round(m.avgSetupMin)}분` : '-'}</td></tr>`).join('')}
    </tbody></table><div class="legend">MTTR: 평균 수리 시간 · MTBF: 평균 고장 간격(가동 시간 기준)</div>`;

  // 추세
  $('#aTrend').innerHTML = a.trend.length ? `<div class="trend">${a.trend.map((t) => `<div class="col"><div class="pct">${Math.round(t.oee * 100)}</div><div class="bar" style="height:${Math.max(4, t.oee * 100)}%"></div><div>${t.date.slice(5)}(${t.weekday})</div></div>`).join('')}</div>` : '';

  // 사유
  $('#aReasons').innerHTML = `<table><thead><tr><th>사유</th><th>손실 분류</th><th class="num">횟수</th><th class="num">합계</th><th>작업자 답변 예</th></tr></thead><tbody>
    ${a.reasons.map((r) => `<tr><td>${esc(r.label)}</td><td>${lossTag(r.loss)}</td><td class="num">${r.count}</td><td class="num">${hrs(r.sec)}</td><td class="muted">${r.examples.map((x) => `“${esc(x)}”`).join(' ')}</td></tr>`).join('')}</tbody></table>`;

  lastStops = a.stops;
  renderStops();
  $('#aWarnings').innerHTML = a.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
}
$('#aPreset').onchange = loadAnalysis;
$('#aMachine').onchange = loadAnalysis;

// 정지 기록 정렬 (화면에서만 바꾼다)
let lastStops = [];
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
  const sorted = [...lastStops].sort(sorters[$('#aSort').value] ?? byTime);
  $('#aStops').innerHTML = stopsTable(sorted);
}
$('#aSort').onchange = renderStops;

function sourceLabel(s) {
  return { 'ct-csv': '전류 센서 CSV', mtconnect: 'MTConnect', opcua: 'OPC UA', 'modbus-csv': 'Modbus', 'mes-csv': 'MES 작업일보', 'live-ct': '실시간 전류 센서', test: '테스트' }[s] ?? s;
}

// ---------- 리포트 ----------
async function loadReport() {
  const r = await api(`/api/report?preset=${$('#rPreset').value}`);
  $('#rText').textContent = r.text;
  $('#btnAi').disabled = !CFG.llm.enabled;
  $('#rHint').textContent = CFG.llm.enabled ? `모델: ${CFG.llm.model}` : 'Claude로 다듬기는 서버에 ANTHROPIC_API_KEY 가 있을 때 켜집니다.';
}
$('#rPreset').onchange = loadReport;
$('#btnCopy').onclick = async () => { await navigator.clipboard.writeText($('#rText').textContent); toast('리포트를 복사했습니다.'); };
$('#btnAi').onclick = async () => {
  $('#btnAi').disabled = true;
  $('#rAi').textContent = 'Claude가 작성 중입니다...';
  try {
    const r = await api('/api/report/ai', { preset: $('#rPreset').value });
    $('#rAi').textContent = r.text;
    $('#rAi').classList.remove('muted');
  } catch (e) { $('#rAi').textContent = `실패: ${e.message}`; } finally { $('#btnAi').disabled = false; }
};

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

async function loadData() {
  const s = await api('/api/samples');
  $('#samples').innerHTML = `<p class="muted">날짜: ${s.date} · 받아서 위에 그대로 올려 보세요.</p><table><tbody>${s.files.map((f) => `<tr><td><a href="/samples/${encodeURIComponent(f.file)}" download>${esc(f.file)}</a></td><td class="muted">${esc(f.description)}</td></tr>`).join('')}</tbody></table>`;
  const imp = await api('/api/imports');
  $('#imports').innerHTML = imp.length ? `<table><thead><tr><th>시각</th><th>파일</th><th>형식</th><th class="num">설비·일</th></tr></thead><tbody>${imp.map((i) => `<tr><td>${new Date(i.at).toLocaleString('ko-KR')}</td><td>${esc(i.file)}</td><td>${esc(sourceLabel(i.format))}</td><td class="num">${i.days}${i.defects ? ` · 불량 ${i.defects}` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">아직 없습니다.</p>';
  $('#realData').innerHTML = `<p class="muted">아래 데이터는 대부분 예지보전·품질용이라 "정지 사유"가 없습니다. 그 빈칸을 채우는 것이 이 서비스의 역할입니다.</p><ul class="links">${REAL_DATA.map((d) => `<li><a href="${d.url}" target="_blank" rel="noopener">${esc(d.name)}</a> — <span class="muted">${esc(d.note)}</span></li>`).join('')}</ul>`;
}
$('#btnUpload').onclick = async () => {
  const files = [...$('#file').files];
  if (!files.length) { toast('파일을 먼저 고르세요.'); return; }
  const out = [];
  for (const f of files) {
    try {
      const r = await api('/api/import', { filename: f.name, content: await f.text(), format: $('#fileFormat').value });
      out.push(`<div class="result">✔ ${esc(f.name)} → ${esc(sourceLabel(r.format))}, ${r.imported.map((d) => `${d.machineId} ${d.date} (정지 ${d.stops}건, 생산 ${d.count}개)`).join(', ') || `불량 ${r.defects}건 연결`}</div>`);
    } catch (e) {
      out.push(`<div class="result err">✖ ${esc(f.name)}: ${esc(e.message)}</div>`);
    }
  }
  $('#uploadResult').innerHTML = out.join('') + '<p class="hint">가져온 날짜는 "손실 분석"에서 기간을 바꿔 확인하세요. 가져온 데이터에는 정지 사유가 비어 있으니 정지 기록에서 사유를 입력해 보세요.</p>';
  const cfg = await api('/api/config');
  CFG.dates = cfg.dates;
  loadData();
};
$('#btnDemo').onclick = async () => {
  if (!confirm('저장된 데이터를 모두 지우고 최근 2주 데모 데이터를 다시 만들까요?')) return;
  const r = await api('/api/demo/reload', {});
  toast(`데모 데이터 ${r.days}건을 만들었습니다 (${r.dates[0]} ~ ${r.dates.at(-1)}).`);
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
  $('#factoryName').textContent = `${CFG.factory.name} · 근무 ${clock(CFG.shift.start)}~${clock(CFG.shift.end)} (점심 제외)`;
  $('#llmBadge').textContent = CFG.llm.enabled ? `사유 분류: Claude (${CFG.llm.model})` : '사유 분류: 규칙 기반 (API 키 없음)';
  $('#llmBadge').classList.toggle('on', CFG.llm.enabled);
  $('#aMachine').innerHTML += CFG.machines.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  LIVE = await api('/api/live');
  renderLive();
  refreshLiveAnalysis();
  const es = new EventSource('/api/events');
  es.addEventListener('live', (e) => { LIVE = JSON.parse(e.data); renderLive(); });
  setInterval(() => { if (LIVE?.running) refreshLiveAnalysis(); }, 1000);
}
init().catch((e) => toast(`서버에 연결하지 못했습니다: ${e.message}`, 8000));
