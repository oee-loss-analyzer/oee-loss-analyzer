// 가상 공장 시뮬레이터.
// 설비 하루치의 "정답(ground truth)"을 만든다: 언제 돌았고, 언제 왜 멈췄고, 제품이 언제 나왔고, 불량이 언제 났는지.
// 이 정답을 산업 데이터 형식(전류 CSV, MTConnect, OPC UA, Modbus, MES)으로 바꾸는 일은 formats.js 가 한다.

import { SHIFT, plannedWindows, DETECTION } from '../config.js';
import { makeRng } from './random.js';

// 작업자가 실제로 할 법한 말 (사유 분류기 테스트용)
export const UTTERANCES = {
  BREAKDOWN: [
    '모터에서 탄 냄새 나요', '유압이 안 올라가요', '알람 떠서 멈췄어요 E-203', '이상한 소리 나서 세웠어요',
    '베어링 쪽에서 소리 나서 수리 중', '히터 하나가 안 올라와요', '누유가 있어서 정비 불렀어요', '차단기가 내려갔어요',
  ],
  SETUP: [
    '금형 바꿨어요', '금형 교체 중입니다', '공구 갈았어요', '품번 바뀌어서 세팅 중', '다이 교체했어요', '툴 교체요',
  ],
  ADJUST: [
    '치수 맞추느라요', '초품 검사 받는 중', '시사출 하고 있어요', '조건 다시 잡는 중', '보정 좀 했어요',
  ],
  MATERIAL: [
    '자재 안 와서요', '소재 떨어졌어요', '지게차 기다리는 중', '레진 건조가 덜 돼서 대기', '코일 입고 대기요',
  ],
  OPERATOR: [
    '사람이 없어서요', '작업자 교육 갔어요', '회의 다녀왔어요', '옆 라인 지원 갔다 왔어요',
  ],
  JAM: [
    '볼트 걸려서 뺐어요', '제품이 끼었어요', '슈트 막혀서요', '취출이 안 돼서 뺐어요', '스크랩이 엉켜서요',
  ],
  CLEAN: [
    '칩 치웠어요', '청소했어요', '주유하고 점검했어요', '금형 그리스 칠했어요',
  ],
  OTHER: ['그냥 잠깐 세웠어요', '품질팀이 세우래요'],
};

// 설비 종류별 하루 이벤트 확률·시간(분)
const PROFILES = {
  press: {
    stops: [
      { code: 'SETUP', count: [1, 3], min: [20, 38] },
      { code: 'JAM', count: [3, 7], min: [2.2, 5] },
      { code: 'MATERIAL', count: [0, 2], min: [8, 22] },
      { code: 'CLEAN', count: [0, 1], min: [8, 14] },
      { code: 'OPERATOR', count: [0, 1], min: [10, 20] },
      { code: 'BREAKDOWN', prob: 0.22, min: [30, 110] },
    ],
    speed: { base: 1.06, afternoon: 1.1 },
    microPerHour: [6, 12], microSec: [12, 50],
    defectRate: 0.012, startupDefectRate: 0.07,
  },
  cnc: {
    stops: [
      { code: 'SETUP', count: [2, 3], min: [9, 18] },
      { code: 'ADJUST', count: [1, 2], min: [10, 22] },
      { code: 'JAM', count: [0, 2], min: [2.2, 4] },
      { code: 'MATERIAL', count: [0, 1], min: [10, 25] },
      { code: 'CLEAN', count: [1, 1], min: [6, 12] },
      { code: 'BREAKDOWN', prob: 0.15, min: [40, 140] },
    ],
    speed: { base: 1.04, afternoon: 1.07 },
    microPerHour: [1, 3], microSec: [20, 55],
    defectRate: 0.015, startupDefectRate: 0.1,
  },
  injection: {
    stops: [
      { code: 'SETUP', count: [1, 1], min: [40, 65] },
      { code: 'ADJUST', count: [1, 1], min: [10, 20], after: 'SETUP' },
      { code: 'JAM', count: [2, 5], min: [2.2, 4.5] },
      { code: 'MATERIAL', count: [0, 2], min: [10, 25] },
      { code: 'BREAKDOWN', prob: 0.25, min: [30, 90] },
    ],
    // 3호기 사출기: 오후 2~4시에 속도가 눈에 띄게 떨어지는 패턴 (기획서 예시)
    speed: { base: 1.07, afternoon: 1.32 },
    microPerHour: [2, 5], microSec: [15, 50],
    defectRate: 0.02, startupDefectRate: 0.12,
  },
};

const AFTERNOON = { start: 14 * 3600, end: 16 * 3600 };

/**
 * 설비 하루 시뮬레이션
 * @param machine  config.MACHINES 의 항목
 * @param date     'YYYY-MM-DD'
 * @param opts.seed         난수 seed (기본: 설비+날짜)
 * @param opts.startAt      이 시각(초) 이후만 생성 (실시간 모드에서 남은 하루를 다시 만들 때)
 * @param opts.forcedStops  [{start, dur, code}] 반드시 넣을 정지
 * @param opts.initialStartup true면 시작 직후를 초기 수율 구간으로 본다
 */
export function simulateDay(machine, date, opts = {}) {
  const profile = PROFILES[machine.type];
  const rng = makeRng(opts.seed ?? `${machine.id}|${date}`);
  const startAt = opts.startAt ?? SHIFT.start;
  const windows = plannedWindows()
    .map((w) => ({ start: Math.max(w.start, startAt), end: w.end }))
    .filter((w) => w.end - w.start > 60);

  // 1) 정지 이벤트 배치
  const stops = [];
  for (const f of opts.forcedStops ?? []) {
    stops.push({ start: f.start, end: Math.min(f.start + f.dur, SHIFT.end), code: f.code, forced: true });
  }
  const placeStop = (code, durSec) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const w = rng.pick(windows);
      if (!w || w.end - w.start < durSec + 120) continue;
      const start = Math.round(rng.range(w.start + 60, w.end - durSec - 60));
      const end = start + Math.round(durSec);
      if (stops.some((s) => start < s.end + 120 && end > s.start - 120)) continue;
      const stop = { start, end, code };
      stops.push(stop);
      return stop;
    }
    return null;
  };
  // 남은 시간 비율만큼만 이벤트 수를 줄인다 (실시간 모드 재생성 대비)
  const remainRatio = windows.reduce((s, w) => s + w.end - w.start, 0) /
    plannedWindows().reduce((s, w) => s + w.end - w.start, 0);
  if (!opts.noRandomStops) {
    for (const spec of profile.stops) {
      let n;
      if (spec.prob != null) n = rng.chance(spec.prob * remainRatio) ? 1 : 0;
      else n = Math.round(rng.int(spec.count[0], spec.count[1]) * remainRatio);
      for (let i = 0; i < n; i++) {
        if (spec.after) {
          // 셋업 직후 조정 (예: 금형 교체 후 시사출)
          const prev = stops.find((s) => s.code === spec.after && !s.followed);
          if (prev) {
            prev.followed = true;
            const start = prev.end + Math.round(rng.range(60, 240));
            const dur = rng.range(spec.min[0], spec.min[1]) * 60;
            const end = start + Math.round(dur);
            const w = windows.find((x) => start >= x.start && end <= x.end);
            if (w && !stops.some((s) => start < s.end + 30 && end > s.start - 30)) {
              stops.push({ start, end, code: spec.after === 'SETUP' ? 'ADJUST' : spec.code });
            }
            continue;
          }
        }
        placeStop(spec.code, rng.range(spec.min[0], spec.min[1]) * 60);
      }
    }
  }
  stops.sort((a, b) => a.start - b.start);
  for (const s of stops) {
    s.utterance = rng.pick(UTTERANCES[s.code] ?? UTTERANCES.OTHER);
    if (s.code === 'BREAKDOWN') s.alarm = rng.pick(['E-203 유압 저하', 'E-118 모터 과부하', 'E-077 히터 단선', 'E-305 비상정지']);
  }

  // 2) 가동 구간마다 사이클 생성 (순간정지·속도 저하 포함)
  const segments = []; // 화면 표시와 전류 파형 생성용
  const cycles = [];
  const defects = [];
  const micro = [];
  const startupUntil = []; // 초기 수율 구간 종료 시각들

  const runSpans = [];
  for (const w of windows) {
    let cur = w.start;
    for (const s of stops) {
      if (s.end <= w.start || s.start >= w.end) continue;
      if (s.start > cur) runSpans.push({ start: cur, end: s.start });
      cur = Math.max(cur, s.end);
    }
    if (cur < w.end) runSpans.push({ start: cur, end: w.end });
  }

  // 초기 수율 구간: 근무 시작, 점심 후, 셋업·고장 후
  if (startAt === SHIFT.start || opts.initialStartup) startupUntil.push([startAt, startAt + DETECTION.startupWindowSec]);
  for (const b of SHIFT.plannedBreaks) if (b.end > startAt) startupUntil.push([b.end, b.end + DETECTION.startupWindowSec]);
  for (const s of stops) {
    if (['SETUP', 'ADJUST', 'BREAKDOWN'].includes(s.code)) startupUntil.push([s.end, s.end + DETECTION.startupWindowSec]);
  }
  const inStartup = (t) => startupUntil.some(([a, b]) => t >= a && t < b);

  const microProbPerCycle = (rng.range(profile.microPerHour[0], profile.microPerHour[1]) * machine.idealCycleSec) / 3600;
  for (const span of runSpans) {
    let t = span.start;
    let segStart = t;
    while (true) {
      const factor = (t >= AFTERNOON.start && t < AFTERNOON.end ? profile.speed.afternoon : profile.speed.base) *
        (1 + rng.normal(0, 0.025));
      const ct = Math.max(machine.idealCycleSec * 0.97, machine.idealCycleSec * factor);
      if (rng.chance(microProbPerCycle)) {
        const md = Math.round(rng.range(profile.microSec[0], profile.microSec[1]));
        if (t + md + ct > span.end) break;
        if (t > segStart) segments.push({ start: segStart, end: t, kind: 'RUN' });
        micro.push({ start: t, end: t + md });
        segments.push({ start: t, end: t + md, kind: 'MICRO' });
        t += md;
        segStart = t;
      }
      if (t + ct > span.end) break;
      t += ct;
      const ts = Math.round(t * 10) / 10;
      cycles.push(ts);
      const rate = inStartup(ts) ? profile.startupDefectRate : profile.defectRate;
      if (rng.chance(rate)) defects.push({ ts: Math.round(ts), n: 1, startup: inStartup(ts) });
    }
    if (span.end > segStart) segments.push({ start: segStart, end: span.end, kind: 'RUN' });
  }
  for (const s of stops) segments.push({ start: s.start, end: s.end, kind: 'STOP', code: s.code });
  for (const b of SHIFT.plannedBreaks) {
    if (b.end > startAt) segments.push({ start: Math.max(b.start, startAt), end: b.end, kind: 'BREAK' });
  }
  segments.sort((a, b) => a.start - b.start);

  return {
    machineId: machine.id, date, startAt,
    stops: stops.map(({ followed, ...s }) => s),
    segments, cycles, defects, micro,
  };
}

// 전류 파형: 시뮬레이션 결과에서 특정 초의 전류값(A)을 만든다.
export function makeCurrentSampler(machine, truth, seed = 'current') {
  const rng = makeRng(`${machine.id}|${truth.date}|${seed}`);
  const segs = truth.segments;
  const cycleSet = new Set();
  const peakLen = machine.type === 'press' ? 1 : 2;
  for (const c of truth.cycles) {
    for (let k = 0; k < peakLen; k++) cycleSet.add(Math.floor(c) - k);
  }
  let idx = 0;
  return function currentAt(sec) {
    while (idx < segs.length - 1 && segs[idx].end <= sec) idx++;
    while (idx > 0 && segs[idx].start > sec) idx--;
    const seg = segs[idx];
    const noise = () => 1 + rng.normal(0, 0.035);
    if (!seg || sec < seg.start || sec >= seg.end) {
      // 근무 시간 밖: 전원 꺼짐
      return round2(Math.max(0, 0.15 * noise()));
    }
    switch (seg.kind) {
      case 'RUN':
        return round2((cycleSet.has(sec) ? machine.peakCurrentA : machine.runCurrentA) * noise());
      case 'MICRO':
        return round2(machine.idleCurrentA * noise());
      case 'BREAK':
        return round2(Math.max(0, 0.2 * noise()));
      case 'STOP':
        // 고장이면 전원 차단 상태가 많고, 셋업 중에는 가끔 조그(짧은 시운전) 전류가 섞인다
        if (seg.code === 'BREAKDOWN') return round2(Math.max(0, 0.3 * noise()));
        if ((seg.code === 'SETUP' || seg.code === 'ADJUST') && rng.chance(0.01)) return round2(machine.runCurrentA * noise());
        return round2(machine.idleCurrentA * noise());
      default:
        return 0;
    }
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
