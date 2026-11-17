// 예시 파일 묶음: 하루치 / 일주일치(평일 5일)
// 파일을 디스크에 두지 않고 요청이 올 때 만든다 (일주일치 전류 로그는 약 9MB라 저장소에 넣기엔 크다).
// 같은 날짜는 언제 만들어도 같은 내용이다 (난수 seed = sample|설비|날짜, sample-data/ 와 동일).

import { SIM_MACHINES as MACHINES } from './config.js';
import { simulateDay } from './sim/factory.js';
import { FORMATS, encodeDefectLog } from './sim/formats.js';
import { addDays } from './core/time.js';
import { workingDaysBefore } from './demo.js';

export const SAMPLE_END = '2026-11-13';

export const SAMPLE_RANGES = {
  '1d': { days: 1, label: '하루치' },
  '1w': { days: 5, label: '일주일치' },
};

const [PRESS, CNC, INJ] = MACHINES;

// core: "전부 가져오기"에 넣는 파일 (설비·날짜가 서로 겹치지 않는다)
// extra: 같은 설비·날짜를 다른 형식으로 담은 체험용 파일 (가져오면 앞의 기록을 덮어쓴다)
export const SAMPLE_FILES = [
  { key: 'ct', prefix: '01_press_ct-current', ext: 'csv', format: 'ct-csv', machines: [PRESS], who: '1호기 프레스', core: true },
  { key: 'mtconnect', prefix: '02_cnc_mtconnect-sample', ext: 'xml', format: 'mtconnect', machines: [CNC], who: '2호기 CNC', core: true },
  { key: 'opcua', prefix: '03_injection_opcua-pubsub', ext: 'jsonl', format: 'opcua', machines: [INJ], who: '3호기 사출기', core: true },
  { key: 'modbus', prefix: '04_press_modbus-poll', ext: 'csv', format: 'modbus-csv', machines: [PRESS], who: '1호기 프레스', core: false },
  { key: 'mes', prefix: '05_all_mes-daily-report', ext: 'csv', format: 'mes-csv', machines: MACHINES, who: '설비 3대', core: false },
  { key: 'defects', prefix: '06_all_operator-defects', ext: 'json', format: 'defects-json', machines: MACHINES, who: '설비 3대', core: true },
];

export function sampleDates(range) {
  const r = SAMPLE_RANGES[range];
  if (!r) throw Object.assign(new Error(`알 수 없는 기간: ${range}`), { status: 400 });
  return workingDaysBefore(addDays(SAMPLE_END, 1), r.days);
}

const truthCache = new Map();
export function sampleTruth(m, date) { return truth(m, date); }
function truth(m, date) {
  const k = `${m.id}|${date}`;
  if (!truthCache.has(k)) truthCache.set(k, simulateDay(m, date, { seed: `sample|${m.id}|${date}` }));
  return truthCache.get(k);
}

const dropHeader = (text) => text.split('\n').slice(1).join('\n');

/** 예시 파일 한 개의 내용 (기간 안의 날짜를 한 파일에 이어 붙인다) */
export function buildSampleText(range, key) {
  const f = SAMPLE_FILES.find((x) => x.key === key);
  if (!f) throw Object.assign(new Error(`알 수 없는 예시 파일: ${key}`), { status: 404 });
  const dates = sampleDates(range);
  if (f.format === 'defects-json') {
    return JSON.stringify(dates.flatMap((d) => f.machines.flatMap((m) => encodeDefectLog(m, truth(m, d)))), null, 1);
  }
  const parts = [];
  for (const d of dates) {
    for (const m of f.machines) parts.push(FORMATS[f.format].encode(m, truth(m, d)));
  }
  // CSV는 머리줄을 한 번만 둔다. XML·JSONL은 그대로 이어도 읽힌다 (날짜별로 나눠 읽는다)
  if (f.ext === 'csv') return parts.map((p, i) => (i === 0 ? p : dropHeader(p))).join('');
  return parts.join(f.ext === 'xml' ? '\n' : '');
}

export function sampleFileName(range, key) {
  const f = SAMPLE_FILES.find((x) => x.key === key);
  const dates = sampleDates(range);
  const span = dates.length === 1 ? dates[0] : `${dates[0]}_${dates.at(-1)}`;
  return `${f.prefix}_${span}.${f.ext}`;
}

const sizeCache = new Map();
/** 화면의 예시 파일 목록 */
export function listSamples(range) {
  const dates = sampleDates(range);
  return {
    range, label: SAMPLE_RANGES[range].label, from: dates[0], to: dates.at(-1), days: dates.length,
    files: SAMPLE_FILES.map((f) => {
      const k = `${range}|${f.key}`;
      if (!sizeCache.has(k)) sizeCache.set(k, Buffer.byteLength(buildSampleText(range, f.key)));
      return { key: f.key, file: sampleFileName(range, f.key), format: f.format, who: f.who, core: f.core, size: sizeCache.get(k) };
    }),
  };
}
