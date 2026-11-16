// 데모 데이터: 최근 2주(평일 10일)치 가상 공장 데이터를 "실제 데이터 형식"으로 만든 뒤 다시 읽어 들인다.
// 1호기 → 전류 CSV, 2호기 → MTConnect XML, 3호기 → OPC UA JSON. (데이터는 어디서든 받아온다는 것을 보여 주기 위함)

import { MACHINES, DETECTION } from './config.js';
import { simulateDay } from './sim/factory.js';
import { FORMATS } from './sim/formats.js';
import { parseFile } from './ingest/parsers.js';
import { classifyByRules } from './reasons/classifier.js';
import { addDays, todayLocal } from './core/time.js';
import { makeRng } from './sim/random.js';

const SOURCE_FORMAT = { ct: 'ct-csv', mtconnect: 'mtconnect', opcua: 'opcua' };

export function workingDaysBefore(date, n) {
  const out = [];
  let d = date;
  while (out.length < n) {
    d = addDays(d, -1);
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out.reverse();
}

/** 정답 데이터와 감지된 정지를 맞춰 작업자 답변을 흉내 낸다 */
export function simulateAnswers(day, truth, { answerRate = 0.88, seed = 'answers' } = {}) {
  const rng = makeRng(`${day.machineId}|${day.date}|${seed}`);
  const out = [];
  const seen = new Set();
  for (const s of day.stops) {
    if (s.dur < DETECTION.askReasonAfterSec || seen.has(s.group)) continue;
    seen.add(s.group);
    if (!rng.chance(answerRate)) continue;
    const t = truth.stops.find((x) => s.start < x.end && s.end > x.start);
    const text = t?.utterance ?? '잠깐 세웠어요';
    const c = classifyByRules(text, s.hint);
    out.push({ machineId: day.machineId, date: day.date, stopId: s.group, start: s.start, code: c.code, text, method: c.method, confidence: c.confidence, by: 'demo' });
  }
  return out;
}

export function loadDemo(store, { today = todayLocal(), days = 10 } = {}) {
  const dates = workingDaysBefore(today, days);
  let n = 0;
  for (const date of dates) {
    for (const m of MACHINES) {
      const truth = simulateDay(m, date);
      const fmt = SOURCE_FORMAT[m.source] ?? 'ct-csv';
      const text = FORMATS[fmt].encode(m, truth);
      const { days: parsed } = parseFile(text, { format: fmt });
      for (const day of parsed) {
        // 불량은 작업자가 카톡 [불량 +1] 버튼으로 남긴 기록을 붙인다
        day.defects = truth.defects.map((d) => ({ ts: d.ts, n: d.n }));
        day.defectCount = day.defects.length;
        store.upsertDay(day, { silent: true });
        for (const r of simulateAnswers(day, truth)) store.addReason(r);
        n++;
      }
    }
  }
  store.imports.push({ at: new Date().toISOString(), file: `데모 데이터 (${dates[0]} ~ ${dates.at(-1)})`, format: '전류 CSV · MTConnect · OPC UA', days: n });
  store.save();
  return { dates, days: n };
}
