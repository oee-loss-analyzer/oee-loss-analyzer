// OEE 계산과 손실 분해.
//
//  계획 시간 = 근무 시간 − 계획정지(점심)
//  가용 손실 = 고장·셋업·대기·점검 등 정지 (사유가 순간정지면 성능 손실로 옮김)
//  가동 시간 = 계획 시간 − 가용 손실
//  성능 손실 = 가동 시간 − 생산수량 × 이론 사이클   (순간정지 + 속도 저하)
//  품질 손실 = 불량 수량 × 이론 사이클              (초기 수율 + 공정 불량)
//  OEE      = 양품 × 이론 사이클 ÷ 계획 시간 = 시간가동률 × 성능가동률 × 양품률

import { DETECTION, LOSS, SHIFT, plannedWindows, reasonByCode, machineById } from '../config.js';

export function plannedSecUntil(untilSec = SHIFT.end) {
  return plannedWindows().reduce((s, w) => s + Math.max(0, Math.min(w.end, untilSec) - w.start), 0);
}

/** 정지에 붙은 사유 찾기 (정지 시작 시각 근처에 기록된 사유) */
export function findReason(stop, reasons) {
  if (!reasons?.length) return null;
  return reasons.find((r) => r.stopId === stop.id || r.stopId === stop.group) ??
    (stop.start != null ? reasons.find((r) => r.start != null && r.start >= stop.start - 5 && r.start <= (stop.end ?? stop.start) + 5) : null);
}

export function lossOfStop(stop, reason) {
  if (reason?.code) return reasonByCode(reason.code)?.loss ?? 'other_stop';
  if (stop.dur < DETECTION.minorStopMaxSec) return 'minor_stop';
  return 'unknown';
}

/**
 * 설비 하루 분석
 * @param day      DayRecord (canonical.js)
 * @param reasons  해당 설비·날짜의 사유 기록 [{stopId, start, code, text, ...}]
 */
export function analyzeDay(day, reasons = [], { untilSec } = {}) {
  const machine = machineById(day.machineId);
  const ideal = machine.idealCycleSec;
  const until = Math.min(untilSec ?? day.untilSec ?? SHIFT.end, SHIFT.end);
  const plannedSec = plannedSecUntil(until);

  const losses = Object.fromEntries(Object.keys(LOSS).map((k) => [k, 0]));
  const stops = [];
  for (const s of day.stops) {
    const end = s.end == null ? null : Math.min(s.end, until);
    const dur = s.start == null ? s.dur : Math.max(0, end - s.start);
    if (dur <= 0) continue;
    // 그룹(점심을 넘긴 정지 등)은 첫 조각의 사유를 함께 쓴다
    const reason = findReason(s, reasons) ?? findReason({ ...s, id: s.group }, reasons);
    let loss;
    if (day.kind === 'summary') {
      loss = reason?.code ? reasonByCode(reason.code)?.loss ?? 'other_stop' : 'unknown';
    } else loss = lossOfStop({ ...s, dur }, reason);
    losses[loss] += dur;
    stops.push({ ...s, end, dur, loss, reason: reason ?? null, ongoing: s.end != null && s.end > until });
  }

  const availStop = stops.filter((s) => LOSS[s.loss].group === 'availability').reduce((a, s) => a + s.dur, 0);
  const operatingSec = Math.max(0, plannedSec - availStop);
  const count = day.cycles ? day.cycles.filter((c) => c <= until).length : day.count;
  const defectList = (day.defects ?? []).filter((d) => d.ts == null || d.ts <= until);
  const defectCount = Math.min(count, defectList.reduce((a, d) => a + (d.n ?? 1), 0));
  const good = count - defectCount;
  const idealSec = count * ideal;

  // 성능 손실: 기록된 순간정지 + 나머지는 속도 저하 (1분 미만 정지 포함)
  const perfLoss = Math.max(0, operatingSec - idealSec);
  losses.speed = Math.max(0, perfLoss - losses.minor_stop);
  if (losses.minor_stop > perfLoss) losses.minor_stop = perfLoss;

  // 품질 손실: 셋업·고장 직후, 근무·점심 시작 직후 불량은 초기 수율
  const restartPoints = [SHIFT.start, ...SHIFT.plannedBreaks.map((b) => b.end),
    ...stops.filter((s) => ['setup', 'breakdown'].includes(s.loss) && s.end != null).map((s) => s.end)];
  let startupN = 0;
  for (const d of defectList) {
    const isStartup = d.startup ?? (d.ts != null && restartPoints.some((p) => d.ts >= p && d.ts < p + DETECTION.startupWindowSec));
    if (isStartup) startupN += d.n ?? 1;
  }
  startupN = Math.min(startupN, defectCount);
  losses.startup = startupN * ideal;
  losses.defect = (defectCount - startupN) * ideal;

  const warnings = [];
  if (idealSec > operatingSec * 1.03 && operatingSec > 0) {
    warnings.push(`생산수량 × 이론 사이클(${Math.round(idealSec / 60)}분)이 가동 시간(${Math.round(operatingSec / 60)}분)보다 깁니다. 이론 사이클 타임 설정을 확인하세요.`);
  }
  if (day.kind === 'summary') warnings.push('작업일보(합계) 데이터라 정지 시각과 순간정지를 알 수 없습니다. 짧은 정지는 속도 저하에 섞여 있습니다.');

  const availability = plannedSec ? operatingSec / plannedSec : 0;
  const performance = operatingSec ? Math.min(1, idealSec / operatingSec) : 0;
  const quality = count ? good / count : 0;
  const asked = stops.filter((s) => s.start != null && s.dur >= DETECTION.askReasonAfterSec);

  return {
    machineId: day.machineId, date: day.date, source: day.source, kind: day.kind, untilSec: until,
    plannedSec, operatingSec, availStopSec: availStop, idealSec, count, defectCount, good,
    availability, performance, quality, oee: availability * performance * quality,
    losses, stops, warnings,
    asked: asked.length, answered: asked.filter((s) => s.reason?.code).length,
  };
}

/** 여러 설비·날짜 합치기 (비율은 합계로 다시 계산) */
export function aggregate(results) {
  const acc = {
    plannedSec: 0, operatingSec: 0, idealSec: 0, goodIdealSec: 0, count: 0, defectCount: 0, good: 0,
    losses: Object.fromEntries(Object.keys(LOSS).map((k) => [k, 0])), lossWon: Object.fromEntries(Object.keys(LOSS).map((k) => [k, 0])),
    asked: 0, answered: 0, days: results.length,
  };
  for (const r of results) {
    const m = machineById(r.machineId);
    const ideal = m.idealCycleSec;
    acc.plannedSec += r.plannedSec;
    acc.operatingSec += r.operatingSec;
    acc.idealSec += r.idealSec;
    acc.goodIdealSec += r.good * ideal;
    acc.count += r.count;
    acc.defectCount += r.defectCount;
    acc.good += r.good;
    acc.asked += r.asked;
    acc.answered += r.answered;
    for (const [k, v] of Object.entries(r.losses)) {
      acc.losses[k] += v;
      acc.lossWon[k] += (v / ideal) * m.marginPerPart;
    }
  }
  acc.availability = acc.plannedSec ? acc.operatingSec / acc.plannedSec : 0;
  acc.performance = acc.operatingSec ? Math.min(1, acc.idealSec / acc.operatingSec) : 0;
  acc.quality = acc.count ? acc.good / acc.count : 0;
  acc.oee = acc.plannedSec ? acc.goodIdealSec / acc.plannedSec : 0;
  acc.totalLossSec = Object.values(acc.losses).reduce((a, b) => a + b, 0);
  acc.totalLossWon = Object.values(acc.lossWon).reduce((a, b) => a + b, 0);
  acc.responseRate = acc.asked ? acc.answered / acc.asked : null;
  return acc;
}
