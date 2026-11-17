// 공장 설정: 설비, 근무 시간, 판정 기준, 손실 분류.
// 실제 현장에 적용할 때는 이 파일의 값만 바꾸면 된다.

export const FACTORY = {
  name: '경북 OO정밀 (가상 공장)',
  timezone: '+09:00',
};

// 근무 계획. 시간은 "자정부터 지난 초"로 다룬다.
export const SHIFT = {
  start: hms('08:00'),
  end: hms('17:00'),
  // 계획정지: OEE 계산에서 제외되는 시간
  plannedBreaks: [{ start: hms('12:00'), end: hms('13:00'), label: '점심' }],
};

// 설비 정의
//  idealCycleSec : 이론 사이클 타임 (제품 1개를 만드는 최소 시간)
//  runCurrentA   : 가동 중 평균 전류, peakCurrentA: 사이클마다 튀는 전류(프레스 타격, 사출 등)
//  idleCurrentA  : 전원은 켜져 있지만 일을 안 하는 대기 전류
//  marginPerPart : 제품 1개당 이익(원) → 손실 시간을 돈으로 환산할 때 사용
export const MACHINES = [
  {
    id: 'PRESS-01', name: '1호기 프레스', type: 'press',
    idealCycleSec: 6, runCurrentA: 14, peakCurrentA: 32, idleCurrentA: 3.2,
    marginPerPart: 180, source: 'ct',
  },
  {
    id: 'CNC-02', name: '2호기 CNC', type: 'cnc',
    idealCycleSec: 45, runCurrentA: 11, peakCurrentA: 19, idleCurrentA: 2.4,
    marginPerPart: 2600, source: 'mtconnect',
  },
  {
    id: 'INJ-03', name: '3호기 사출기', type: 'injection',
    idealCycleSec: 30, runCurrentA: 21, peakCurrentA: 38, idleCurrentA: 4.5,
    marginPerPart: 650, source: 'opcua',
  },
  // 실제 공개 데이터용 설비: 벽돌 생산라인 (Zenodo, CC BY 4.0). 정지 기록만 있고 전류 신호가 없어 시뮬레이션(sim: false)은 하지 않는다.
  //  idealCycleSec 는 원본의 "계획시간 ÷ 이론 생산량"(약 0.46초/장)에서, marginPerPart 는 벽돌 1장 이익을 가정한 값이다.
  {
    id: 'CLAY-LINE', name: '벽돌 라인', type: 'line',
    idealCycleSec: 0.46, marginPerPart: 30, source: 'mes', sim: false,
  },
  // 공개 데이터: 음료 충전 라인 (Zenodo 18146866, 브라질, CC BY 4.0). 하루 요약 + 정지 기록(사유 없음).
  //  idealCycleSec 는 원본에서 가장 빨랐던 시간대(3L 약 744개/시간)에서 잡았다. 5L 날은 성능가동률이 낮게 나온다.
  {
    id: 'FILL-LINE', name: '충전 라인', type: 'line',
    idealCycleSec: 4.8, marginPerPart: 400, source: 'mes', sim: false,
  },
  // 공개 데이터: 포장기 (Zenodo 7071747 PIADE의 s_1, 이탈리아, CC BY 4.0). 상태 구간 + 알람 코드 + 산출 카운터.
  //  idealCycleSec 는 원본의 최고 속도(5,000개/시간)에서 잡았다.
  {
    id: 'PACK-01', name: '포장기', type: 'packaging',
    idealCycleSec: 0.72, marginPerPart: 20, source: 'opcua', sim: false,
  },
];

// 가상 공장 시뮬레이터(실시간 현장 · 예시 파일)가 돌리는 설비
export const SIM_MACHINES = MACHINES.filter((m) => m.sim !== false);

// 전류 → 상태 판정 기준 (설비별 runCurrent 대비 비율)
export const DETECTION = {
  runRatio: 0.55,        // 이 비율 이상이면 가동
  peakRatio: 0.8,        // 사이클 피크 판정: (peak - run) 의 이 비율을 넘으면 1사이클
  minStopSec: 60,        // 이보다 짧은 정지는 상태 변화로 보지 않음 → 속도 손실에 포함
  askReasonAfterSec: 120,// 이 시간 이상 멈추면 작업자에게 사유를 묻는다
  minorStopMaxSec: 300,  // 사유 없이 5분 미만이면 순간정지로 자동 분류
  startupWindowSec: 15 * 60, // 셋업·시작 직후 이 시간 안의 불량은 초기수율 손실
};

// 손실 분류 (TPM 6대 로스 + 현장에서 흔한 대기 손실)
export const LOSS = {
  breakdown: { label: '고장', group: 'availability', color: '#d9480f' },
  setup: { label: '셋업·조정', group: 'availability', color: '#f08c00' },
  waiting: { label: '대기 (자재·인원)', group: 'availability', color: '#e8590c' },
  other_stop: { label: '점검·청소·기타', group: 'availability', color: '#fab005' },
  unknown: { label: '사유 미입력', group: 'availability', color: '#868e96' },
  minor_stop: { label: '순간정지', group: 'performance', color: '#1c7ed6' },
  speed: { label: '속도 저하', group: 'performance', color: '#4263eb' },
  defect: { label: '공정 불량', group: 'quality', color: '#ae3ec9' },
  startup: { label: '초기 수율', group: 'quality', color: '#d6336c' },
};

// 작업자가 고를 수 있는 사유 버튼 → 손실 분류
export const REASONS = [
  { code: 'BREAKDOWN', label: '고장', loss: 'breakdown' },
  { code: 'SETUP', label: '금형·공구 교체', loss: 'setup' },
  { code: 'ADJUST', label: '조정·시운전', loss: 'setup' },
  { code: 'MATERIAL', label: '자재 대기', loss: 'waiting' },
  { code: 'OPERATOR', label: '작업자 부재', loss: 'waiting' },
  { code: 'JAM', label: '걸림·막힘', loss: 'minor_stop' },
  { code: 'CLEAN', label: '청소·점검', loss: 'other_stop' },
  { code: 'OTHER', label: '기타', loss: 'other_stop' },
];

export function reasonByCode(code) {
  return REASONS.find((r) => r.code === code) ?? null;
}

export function machineById(id) {
  return MACHINES.find((m) => m.id === id) ?? null;
}

export function hms(s) {
  const [h, m, sec = 0] = s.split(':').map(Number);
  return h * 3600 + m * 60 + sec;
}

export function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 계획 가동 구간 (근무 시간에서 계획정지를 뺀 구간들)
export function plannedWindows(shift = SHIFT) {
  const out = [];
  let cur = shift.start;
  for (const b of [...shift.plannedBreaks].sort((a, b2) => a.start - b2.start)) {
    if (b.start > cur) out.push({ start: cur, end: Math.min(b.start, shift.end) });
    cur = Math.max(cur, b.end);
  }
  if (cur < shift.end) out.push({ start: cur, end: shift.end });
  return out;
}

export function plannedSeconds(shift = SHIFT) {
  return plannedWindows(shift).reduce((s, w) => s + (w.end - w.start), 0);
}

export function isPlannedBreak(sec, shift = SHIFT) {
  return shift.plannedBreaks.some((b) => sec >= b.start && sec < b.end);
}
