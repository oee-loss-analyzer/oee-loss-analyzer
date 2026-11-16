// 어떤 데이터 소스든 "설비 하루" 표준 형태로 바꾼다.
//
// DayRecord = {
//   machineId, date, source,
//   kind: 'timeline' | 'summary',   // timeline: 정지 시각을 앎 / summary: MES처럼 합계만 앎
//   stops: [{ id, group, start, end, dur, hint }],   // 계획 가동 시간 안의 정지 (1분 이상)
//   timeline: [{ start, end, state: 'RUN'|'STOP'|'BREAK' }],
//   cycles: [초] | null,  count,                     // 생산 수량
//   defects: [{ ts?, n, startup? }],  defectCount,   // 불량
//   untilSec,                                        // 데이터가 있는 마지막 시각 (실시간이면 지금)
// }

import { SHIFT, DETECTION, plannedWindows, machineById } from './../config.js';

const JOG_MERGE_SEC = 30; // 정지 중 30초 미만의 짧은 가동(조그, 시운전)은 정지로 묶는다

/**
 * 상태 변화 이벤트 → DayRecord
 * @param stateEvents [{ t, running, hint? }] 시각순이 아니어도 됨
 */
export function buildDayFromStates({ machineId, date, source, stateEvents, cycles = null, defects = [], untilSec = SHIFT.end }) {
  const machine = machineById(machineId);
  if (!machine) throw new Error(`알 수 없는 설비: ${machineId}`);
  const evs = [...stateEvents].sort((a, b) => a.t - b.t);
  const end = Math.min(untilSec, SHIFT.end);

  // 1) 원시 구간 만들기
  let raw = [];
  for (let i = 0; i < evs.length; i++) {
    const s = Math.max(evs[i].t, SHIFT.start);
    const e = Math.min(i + 1 < evs.length ? evs[i + 1].t : end, end);
    if (e <= s) continue;
    const last = raw[raw.length - 1];
    if (last && last.running === evs[i].running) {
      last.end = e;
      if (evs[i].hint && !last.hint) last.hint = evs[i].hint;
    } else {
      raw.push({ start: s, end: e, running: evs[i].running, hint: evs[i].hint ?? null });
    }
  }
  // 근무 시작부터 첫 이벤트 전까지 데이터가 없으면 정지로 본다
  if (raw.length && raw[0].start > SHIFT.start) raw.unshift({ start: SHIFT.start, end: raw[0].start, running: false, hint: '데이터 없음' });
  if (!raw.length) raw = [{ start: SHIFT.start, end, running: false, hint: '데이터 없음' }];

  // 2) 긴 정지 사이에 낀 짧은 가동(셋업 중 조그·시운전)은 하나의 정지로 합친다.
  //    짧은 정지끼리는 합치지 않는다 (순간정지가 연달아 난 것을 긴 정지로 오해하지 않도록)
  const merged = [];
  const dur = (x) => x.end - x.start;
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    const prev2 = merged[merged.length - 2];
    const blip = prev && prev.running && prev2 && !prev2.running && !r.running && (
      dur(prev) < Math.max(2, machine.idealCycleSec * 0.5) || // 사이클 하나도 못 도는 순간 전류 (조그)
      (dur(prev) < JOG_MERGE_SEC && dur(prev2) >= DETECTION.minStopSec && dur(r) >= DETECTION.minStopSec));
    if (blip) {
      merged.pop();
      prev2.end = r.end;
      prev2.hint = prev2.hint ?? r.hint;
      continue;
    }
    if (prev && prev.running === r.running) {
      prev.end = r.end;
      prev.hint = prev.hint ?? r.hint;
      continue;
    }
    merged.push({ ...r });
  }

  // 3) 1분 미만 정지는 가동으로 본다 (→ 성능 손실 '속도 저하'에 포함)
  const smoothed = [];
  for (const r of merged) {
    const state = r.running || r.end - r.start < DETECTION.minStopSec ? true : false;
    const prev = smoothed[smoothed.length - 1];
    if (prev && prev.running === state) prev.end = r.end;
    else smoothed.push({ start: r.start, end: r.end, running: state, hint: state ? null : r.hint });
  }

  // 4) 계획 가동 구간으로 자르기 (점심 등 계획정지는 제외)
  const windows = plannedWindows();
  const stops = [];
  const timeline = [];
  for (const r of smoothed) {
    let group = null;
    for (const w of windows) {
      const s = Math.max(r.start, w.start);
      const e = Math.min(r.end, w.end);
      if (e <= s) continue;
      timeline.push({ start: s, end: e, state: r.running ? 'RUN' : 'STOP' });
      if (!r.running) {
        const id = `${machineId}|${date}|${Math.round(s)}`;
        group = group ?? id;
        stops.push({ id, group, start: Math.round(s), end: Math.round(e), dur: Math.round(e - s), hint: r.hint ?? null });
      }
    }
  }
  for (const b of SHIFT.plannedBreaks) {
    if (b.start < end) timeline.push({ start: b.start, end: Math.min(b.end, end), state: 'BREAK' });
  }
  timeline.sort((a, b) => a.start - b.start);

  const cyc = cycles ? cycles.filter((c) => c >= SHIFT.start && c <= end).sort((a, b) => a - b) : null;
  const def = defects.filter((d) => d.ts == null || (d.ts >= SHIFT.start && d.ts <= end));
  return {
    machineId, date, source, kind: 'timeline',
    stops, timeline,
    cycles: cyc, count: cyc ? cyc.length : 0,
    defects: def, defectCount: def.reduce((s, d) => s + (d.n ?? 1), 0),
    untilSec: end,
  };
}

/** MES 작업일보처럼 합계만 있는 경우 */
export function buildDayFromSummary({ machineId, date, source, downtimes, count, defectCount, workStart, workEnd }) {
  const stops = downtimes.map((d, i) => ({
    id: `${machineId}|${date}|S${i}`, group: `${machineId}|${date}|S${i}`,
    start: null, end: null, dur: Math.round(d.dur), hint: null, text: d.text ?? '',
  }));
  // 작업 시작 전·종료 후의 계획 시간도 비가동으로 본다 (작업일보에 안 적힌 손실)
  const windows = plannedWindows();
  let gap = 0;
  if (workStart != null) for (const w of windows) gap += Math.max(0, Math.min(w.end, workStart) - w.start);
  if (workEnd != null) for (const w of windows) gap += Math.max(0, w.end - Math.max(w.start, workEnd));
  if (gap >= DETECTION.minStopSec) {
    stops.push({ id: `${machineId}|${date}|GAP`, group: `${machineId}|${date}|GAP`, start: null, end: null, dur: Math.round(gap), hint: '작업일보 작업시간 밖', text: '' });
  }
  return {
    machineId, date, source, kind: 'summary',
    stops, timeline: [],
    cycles: null, count,
    defects: defectCount ? [{ n: defectCount }] : [], defectCount,
    untilSec: SHIFT.end,
  };
}

// 전류 샘플(1초 간격 권장) → 상태 이벤트 + 사이클
export function currentToEvents(machine, samples) {
  const runTh = machine.runCurrentA * DETECTION.runRatio;
  const peakTh = machine.runCurrentA + (machine.peakCurrentA - machine.runCurrentA) * DETECTION.peakRatio;
  const refractory = machine.idealCycleSec * 0.5;
  const stateEvents = [];
  const cycles = [];
  let running = null;
  let above = false;
  let lastPeak = -Infinity;
  for (const [t, a] of samples) {
    const r = a >= runTh;
    if (r !== running) {
      stateEvents.push({ t, running: r, hint: !r && a < machine.idleCurrentA * 0.4 ? '전원 꺼짐 (전류 거의 0)' : null });
      running = r;
    }
    const isAbove = a >= peakTh;
    if (isAbove && !above && t - lastPeak >= refractory) {
      cycles.push(t);
      lastPeak = t;
    }
    above = isAbove;
  }
  return { stateEvents, cycles };
}
