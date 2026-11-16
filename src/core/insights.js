// 손실 패턴 찾기 + 공장장용 문장 리포트

import { LOSS, MACHINES, SHIFT, machineById, plannedWindows, reasonByCode } from '../config.js';
import { aggregate } from './oee.js';
import { weekdayKo } from './time.js';

const HOURS = [];
for (let h = Math.floor(SHIFT.start / 3600); h < Math.ceil(SHIFT.end / 3600); h++) HOURS.push(h);

function overlap(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** 시간대별 손실(분). 반환: { hours, rows: [{machineId, values:[{hour, avail, perf, total}]}] } */
export function hourlyLoss(results, dayMap) {
  const windows = plannedWindows();
  const rows = MACHINES.map((m) => ({ machineId: m.id, values: HOURS.map((hour) => ({ hour, avail: 0, perf: 0, total: 0, planned: 0 })) }));
  for (const r of results) {
    const day = dayMap.get(`${r.machineId}|${r.date}`);
    if (!day || day.kind !== 'timeline' || !day.cycles) continue;
    const m = machineById(r.machineId);
    const row = rows.find((x) => x.machineId === r.machineId);
    HOURS.forEach((hour, i) => {
      const h1 = hour * 3600;
      const h2 = Math.min(h1 + 3600, r.untilSec);
      if (h2 <= h1) return;
      const planned = windows.reduce((s, w) => s + overlap(w.start, w.end, h1, h2), 0);
      if (!planned) return;
      let avail = 0;
      let minor = 0;
      for (const s of r.stops) {
        if (s.start == null) continue;
        const o = overlap(s.start, s.end, h1, h2);
        if (!o) continue;
        if (LOSS[s.loss].group === 'availability') avail += o; else minor += o;
      }
      const made = day.cycles.filter((c) => c > h1 && c <= h2).length;
      const perf = Math.max(0, planned - avail - made * m.idealCycleSec);
      const v = row.values[i];
      v.avail += avail / 60;
      v.perf += perf / 60;
      v.total += (avail + perf) / 60;
      v.planned += planned / 60;
    });
  }
  return { hours: HOURS, rows };
}

/** 사유별 집계 */
export function reasonStats(results) {
  const map = new Map();
  for (const r of results) {
    for (const s of r.stops) {
      const key = s.reason?.code ?? (s.loss === 'minor_stop' ? 'AUTO_MINOR' : 'UNANSWERED');
      if (!map.has(key)) {
        const label = s.reason?.code ? reasonByCode(s.reason.code).label : key === 'AUTO_MINOR' ? '짧은 정지 (자동 분류)' : '사유 미입력';
        map.set(key, { code: key, label, loss: s.loss, count: 0, sec: 0, machines: new Set(), examples: [] });
      }
      const e = map.get(key);
      e.count += 1;
      e.sec += s.dur;
      e.machines.add(r.machineId);
      if (s.reason?.text && e.examples.length < 3 && !e.examples.includes(s.reason.text)) e.examples.push(s.reason.text);
    }
  }
  return [...map.values()].map((e) => ({ ...e, machines: [...e.machines] })).sort((a, b) => b.sec - a.sec);
}

/** 설비별 고장·셋업 통계 */
export function machineStats(results) {
  return MACHINES.map((m) => {
    const rs = results.filter((r) => r.machineId === m.id);
    const agg = aggregate(rs);
    const bd = rs.flatMap((r) => r.stops.filter((s) => s.loss === 'breakdown'));
    const setups = rs.flatMap((r) => r.stops.filter((s) => s.reason?.code === 'SETUP'));
    const runSec = rs.reduce((a, r) => a + r.operatingSec, 0);
    return {
      machineId: m.id, name: m.name, days: rs.length, agg,
      breakdowns: bd.length,
      mttrMin: bd.length ? bd.reduce((a, s) => a + s.dur, 0) / bd.length / 60 : null,
      mtbfHours: bd.length ? runSec / bd.length / 3600 : null,
      setups: setups.length,
      avgSetupMin: setups.length ? setups.reduce((a, s) => a + s.dur, 0) / setups.length / 60 : null,
      topLoss: Object.entries(agg.losses).sort((a, b) => b[1] - a[1])[0],
    };
  });
}

export function dailyTrend(results) {
  const dates = [...new Set(results.map((r) => r.date))].sort();
  return dates.map((date) => {
    const agg = aggregate(results.filter((r) => r.date === date));
    return { date, weekday: weekdayKo(date), oee: agg.oee, availability: agg.availability, performance: agg.performance, quality: agg.quality };
  });
}

const won = (x) => (x >= 1e8 ? `${(x / 1e8).toFixed(1)}억 원` : x >= 1e4 ? `${Math.round(x / 1e4).toLocaleString('ko-KR')}만 원` : `${Math.round(x).toLocaleString('ko-KR')}원`);
const hrs = (sec) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)}시간` : `${Math.round(sec / 60)}분`);
const pct = (x) => `${Math.round(x * 100)}%`;

/** 발견 사항(문장) 만들기 */
export function findInsights(results, dayMap) {
  const out = [];
  if (!results.length) return out;
  const stats = machineStats(results);
  const hourly = hourlyLoss(results, dayMap);
  const reasons = reasonStats(results);
  const total = aggregate(results);

  // 1) 가장 큰 손실
  const top = Object.entries(total.losses).sort((a, b) => b[1] - a[1]);
  if (top[0] && top[0][1] > 0) {
    out.push({ level: 'key', text: `가장 큰 손실은 "${LOSS[top[0][0]].label}"입니다. 기간 합계 ${hrs(top[0][1])} (약 ${won(total.lossWon[top[0][0]])}).` });
  }
  // 2) 숨은 손실: 속도 저하가 눈에 보이는 정지보다 클 때
  for (const s of stats) {
    const l = s.agg.losses;
    const visible = l.breakdown + l.setup + l.waiting + l.other_stop + l.unknown;
    if (l.speed > 0 && l.speed > visible * 0.8 && l.speed > 1800) {
      out.push({ level: 'key', machineId: s.machineId, text: `${s.name}: 아무도 기록하지 않은 "속도 저하"가 ${hrs(l.speed)}로, 눈에 보이는 정지(${hrs(visible)})만큼 큽니다.` });
    }
  }
  // 3) 시간대 패턴
  for (const row of hourly.rows) {
    const vals = row.values.filter((v) => v.planned > 0);
    if (vals.length < 4) continue;
    const perfRate = vals.map((v) => ({ hour: v.hour, rate: v.perf / v.planned }));
    const avg = perfRate.reduce((a, v) => a + v.rate, 0) / perfRate.length;
    const hot = perfRate.filter((v) => v.rate > avg * 1.5 && v.rate > 0.12).map((v) => v.hour);
    if (hot.length) {
      const m = machineById(row.machineId);
      const band = contiguousBands(hot).map(([a, b]) => `${a}~${b + 1}시`).join(', ');
      out.push({ level: 'pattern', machineId: m.id, text: `${m.name}: 속도 저하가 ${band}에 몰립니다 (평소의 ${(Math.max(...perfRate.filter((v) => hot.includes(v.hour)).map((v) => v.rate)) / avg).toFixed(1)}배). 그 시간대 작업자 교대·자재 공급·설비 온도를 확인해 보세요.` });
    }
  }
  // 4) 반복되는 사유
  for (const r of reasons.filter((x) => x.code === 'JAM' && x.count >= 8)) {
    out.push({ level: 'pattern', text: `"걸림·막힘"이 ${r.count}번 반복됐습니다 (합계 ${hrs(r.sec)}). 짧아도 자주 나면 공급·취출 장치 점검이 효과적입니다.` });
  }
  // 5) 셋업 시간 편차: 같은 설비인데 날마다 셋업 시간이 크게 다르면 표준화 여지가 있다
  //    (종류가 다른 설비끼리는 셋업 내용이 달라 비교하지 않는다)
  for (const s of stats) {
    const durs = results.filter((r) => r.machineId === s.machineId)
      .flatMap((r) => r.stops.filter((x) => x.reason?.code === 'SETUP').map((x) => x.dur / 60));
    if (durs.length < 3) continue;
    const lo = Math.min(...durs);
    const hi = Math.max(...durs);
    if (hi > lo * 1.5 && hi - lo >= 8) {
      const saving = (s.avgSetupMin - lo) * durs.length * 60;
      out.push({ level: 'pattern', machineId: s.machineId, text: `${s.name}: 셋업이 짧게는 ${Math.round(lo)}분, 길게는 ${Math.round(hi)}분 걸립니다 (평균 ${Math.round(s.avgSetupMin)}분, ${durs.length}회). 가장 빨랐던 방식으로 표준화하면 이 기간 기준 약 ${hrs(saving)}을 되찾을 수 있습니다.` });
    }
  }
  // 6) 고장
  for (const s of stats.filter((x) => x.breakdowns >= 2)) {
    out.push({ level: 'pattern', machineId: s.machineId, text: `${s.name}: 고장 ${s.breakdowns}회, 평균 수리 ${Math.round(s.mttrMin)}분(MTTR), 평균 고장 간격 ${s.mtbfHours.toFixed(1)}시간(MTBF). 반복되면 부품 교체를 검토하세요.` });
  }
  // 7) 응답률
  if (total.responseRate != null && total.responseRate < 0.8) {
    out.push({ level: 'data', text: `정지 사유 응답률이 ${pct(total.responseRate)}입니다. 사유 미입력 정지 ${hrs(total.losses.unknown)}는 원인을 알 수 없어 개선 대상에서 빠집니다.` });
  }
  return out;
}

function contiguousBands(hours) {
  const out = [];
  for (const h of hours.sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && h === last[1] + 1) last[1] = h; else out.push([h, h]);
  }
  return out;
}

/** 공장장에게 보내는 주간 리포트 (템플릿 문장) */
export function buildReport(results, dayMap, { prevResults = [], from, to } = {}) {
  const total = aggregate(results);
  const prev = prevResults.length ? aggregate(prevResults) : null;
  const stats = machineStats(results);
  const insights = findInsights(results, dayMap);
  const lines = [];
  lines.push(`📊 설비 손실 리포트 (${from} ~ ${to})`);
  lines.push(`공장 전체 OEE ${pct(total.oee)}${prev ? ` (전 기간 대비 ${total.oee >= prev.oee ? '+' : ''}${Math.round((total.oee - prev.oee) * 100)}%p)` : ''} · 시간가동률 ${pct(total.availability)} · 성능 ${pct(total.performance)} · 양품률 ${pct(total.quality)}`);
  lines.push(`잃어버린 시간 ${hrs(total.totalLossSec)} ≈ ${won(total.totalLossWon)} (제품 이익 기준 추정)`);
  if (total.responseRate != null) lines.push(`정지 사유 응답률 ${pct(total.responseRate)} (${total.answered}/${total.asked}건)`);
  lines.push('');
  for (const s of stats) {
    if (!s.days) continue;
    const ranked = Object.entries(s.agg.losses).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    lines.push(`■ ${s.name}  OEE ${pct(s.agg.oee)}`);
    ranked.slice(0, 2).forEach(([k, v], i) => {
      lines.push(`  ${i === 0 ? '가장 큰 손실' : '두 번째'}: ${LOSS[k].label} ${hrs(v)} (약 ${won(s.agg.lossWon[k])})`);
    });
    for (const ins of insights.filter((x) => x.machineId === s.machineId)) lines.push(`  💡 ${ins.text.replace(`${s.name}: `, '').replace(`${s.name}의 `, '')}`);
    lines.push('');
  }
  const general = insights.filter((x) => !x.machineId);
  if (general.length) {
    lines.push('■ 공장 전체');
    for (const g of general) lines.push(`  • ${g.text}`);
  }
  return {
    text: lines.join('\n').trim(),
    facts: {
      period: { from, to }, factoryOEE: round(total.oee), previousOEE: prev ? round(prev.oee) : null,
      availability: round(total.availability), performance: round(total.performance), quality: round(total.quality),
      lossHours: Object.fromEntries(Object.entries(total.losses).map(([k, v]) => [LOSS[k].label, round(v / 3600)])),
      lossWon: Math.round(total.totalLossWon), responseRate: total.responseRate == null ? null : round(total.responseRate),
      machines: stats.filter((s) => s.days).map((s) => ({
        name: s.name, oee: round(s.agg.oee), lossHours: Object.fromEntries(Object.entries(s.agg.losses).filter(([, v]) => v > 0).map(([k, v]) => [LOSS[k].label, round(v / 3600)])),
        breakdowns: s.breakdowns, mttrMin: s.mttrMin && Math.round(s.mttrMin), avgSetupMin: s.avgSetupMin && Math.round(s.avgSetupMin),
      })),
      insights: insights.map((i) => i.text),
    },
  };
}

const round = (x) => Math.round(x * 1000) / 1000;
