import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SIM_MACHINES as MACHINES, SHIFT, plannedSeconds, hms } from '../src/config.js'; // 시뮬레이터로 만드는 설비만 (벽돌 라인 제외)
import { simulateDay } from '../src/sim/factory.js';
import { FORMATS } from '../src/sim/formats.js';
import { parseFile, detectFormat } from '../src/ingest/parsers.js';
import { analyzeDay } from '../src/core/oee.js';
import { buildDayFromStates } from '../src/core/canonical.js';
import { classifyByRules } from '../src/reasons/classifier.js';
import { simulateAnswers } from '../src/demo.js';

const DATE = '2026-11-10';

// 시뮬레이션 정답에서 1분 이상 정지만 골라낸 "기대값"
function truthStops(truth) {
  return truth.stops.filter((s) => s.end - s.start >= 60);
}

for (const fmt of ['ct-csv', 'mtconnect', 'opcua', 'modbus-csv']) {
  test(`${fmt}: 내보낸 데이터를 다시 읽으면 정지·생산수량이 정답과 맞는다`, () => {
    for (const [m, date] of MACHINES.flatMap((mm) => ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'].map((d) => [mm, d]))) {
      const truth = simulateDay(m, date);
      const text = FORMATS[fmt].encode(m, truth);
      assert.equal(detectFormat(text), fmt);
      const { days } = parseFile(text);
      assert.equal(days.length, 1);
      const day = days[0];
      assert.equal(day.machineId, m.id);
      assert.equal(day.date, date);

      // 생산 수량: 오차 1% 이내 (폴링 경계 등)
      const tol = Math.max(2, truth.cycles.length * 0.01);
      assert.ok(Math.abs(day.count - truth.cycles.length) <= tol, `${m.id} count ${day.count} vs ${truth.cycles.length}`);

      // 정답의 정지(1분 이상)는 모두 감지되어야 한다 (시작 시각 ±10초)
      for (const t of truthStops(truth)) {
        const hit = day.stops.find((s) => Math.abs(s.start - Math.max(t.start, SHIFT.start)) <= 10 ||
          (t.start < s.end && t.end > s.start));
        assert.ok(hit, `${fmt} ${m.id}: ${t.code} ${t.start}~${t.end} 정지를 놓침`);
      }
      // 감지된 정지 합계가 정답 합계와 크게 다르지 않아야 한다
      const want = truthStops(truth).reduce((a, s) => a + (s.end - s.start), 0);
      const got = day.stops.reduce((a, s) => a + s.dur, 0);
      assert.ok(Math.abs(got - want) <= Math.max(120, want * 0.05), `${fmt} ${m.id} stop total ${got} vs ${want}`);
    }
  });
}

test('MES 작업일보: 합계 데이터로도 OEE가 계산된다', () => {
  const m = MACHINES[2];
  const truth = simulateDay(m, DATE);
  const { days } = parseFile(FORMATS['mes-csv'].encode(m, truth));
  const r = analyzeDay(days[0], []);
  assert.equal(r.kind, 'summary');
  assert.ok(r.oee > 0.2 && r.oee < 1, `oee ${r.oee}`);
  assert.ok(r.warnings.some((w) => w.includes('작업일보')));
});

test('OEE = 시간가동률 × 성능가동률 × 양품률, 손실 합계 = 계획시간 − 양품×이론사이클', () => {
  for (const m of MACHINES) {
    const truth = simulateDay(m, DATE);
    const { days } = parseFile(FORMATS['ct-csv'].encode(m, truth));
    const day = days[0];
    day.defects = truth.defects;
    const answers = simulateAnswers(day, truth, { answerRate: 1 });
    const r = analyzeDay(day, answers);
    assert.equal(r.plannedSec, plannedSeconds());
    const lossSum = Object.values(r.losses).reduce((a, b) => a + b, 0);
    const expected = r.plannedSec - r.good * m.idealCycleSec;
    assert.ok(Math.abs(lossSum - expected) < 1, `${m.id}: loss ${lossSum} vs ${expected}`);
    assert.ok(Math.abs(r.oee - (r.good * m.idealCycleSec) / r.plannedSec) < 1e-9);
    assert.equal(r.losses.unknown, 0, '모든 정지에 답하면 사유 미입력은 0');
  }
});

test('기획서 예시: 정지 55분, 생산 720개, 불량 30개 → OEE 약 72%', () => {
  const machine = MACHINES[2]; // 3호기 사출기, 이론 사이클 30초
  // 08:00 가동 → 09:40~10:20 정지(금형 교체) → 점심 → 13:00~13:15 정지(볼트 걸림) → 17:00
  const events = [
    { t: hms('08:00'), running: true }, { t: hms('09:40'), running: false }, { t: hms('10:20'), running: true },
    { t: hms('13:00'), running: false }, { t: hms('13:15'), running: true },
  ];
  // 오후에 720개가 고르게 나왔다고 가정 (수량만 맞으면 됨)
  const cycles = Array.from({ length: 720 }, (_, i) => hms('13:16') + i * 18);
  const day = buildDayFromStates({ machineId: machine.id, date: DATE, source: 'test', stateEvents: events, cycles, defects: [{ n: 30 }] });
  const reasons = [
    { stopId: `${machine.id}|${DATE}|${hms('09:40')}`, code: 'SETUP' },
    { stopId: `${machine.id}|${DATE}|${hms('13:00')}`, code: 'JAM' },
  ];
  const r = analyzeDay(day, reasons);
  assert.equal(r.plannedSec, 480 * 60);
  assert.equal(Math.round(r.oee * 100), 72);
  assert.equal(r.losses.setup, 40 * 60);
  assert.equal(r.losses.minor_stop, 15 * 60);
  assert.equal(Math.round(r.losses.speed / 60), 65);
  assert.equal(r.losses.defect + r.losses.startup, 15 * 60);
});

test('규칙 기반 사유 분류', () => {
  const cases = {
    '모터에서 탄 냄새 나요': 'BREAKDOWN', '금형 바꿨어요': 'SETUP', '볼트 걸려서 뺐어요': 'JAM', '자재 안 와서요': 'MATERIAL',
    '치수 맞추느라요': 'ADJUST', '칩 치웠어요': 'CLEAN', '베어링 교체했어요': 'BREAKDOWN', '작업자 교육 갔어요': 'OPERATOR',
    '알람 떠서 멈췄어요 E-203': 'BREAKDOWN', '지게차 기다리는 중': 'MATERIAL',
  };
  for (const [text, code] of Object.entries(cases)) assert.equal(classifyByRules(text).code, code, text);
  assert.equal(classifyByRules('ㅇㅇ').code, 'OTHER');
});
