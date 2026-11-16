import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertPeriod, STOP_KO, LOC_KO, locationLabel } from '../scripts/convert-heavy-clay.js';
import { parseFile } from '../src/ingest/parsers.js';
import { analyzeDay } from '../src/core/oee.js';
import { classifyByRules } from '../src/reasons/classifier.js';
import { reasonByCode, SIM_MACHINES, MACHINES } from '../src/config.js';

// 원본(Zenodo 벽돌 라인)과 같은 모양의 작은 파일: 하루, 정지 4건 (+ 계산에서 빠지는 계획 정지 1건)
const DOWNTIME = `﻿Date,Productcode,StopGroup,Stop,StopType,StopLocation,ExtraText,StopStartTime,StopEndTime,StopDuration(min)
9/22/25,KK200-1,OPERATIONAL,NO PRODUCTION SCHEDULE,Planned - Not included in OEE,EXTRUDER PRESS,-,2025-09-22 07:15,2025-09-22 10:31,196.9
9/22/25,KK200-1,FAILURE,MECHANICAL FAILURE,Unplanned,CUTTER,,2025-09-22 10:58,2025-09-22 11:28,30
9/22/25,KK200-1,SETUPS-CHANGEOVERS,MATERIAL CHANGEOVER,Planned - Included in OEE,EXTRUDER PRESS,"text, with comma",2025-09-22 12:00,2025-09-22 12:20,20
9/22/25,KK200-1,MATERIALS,MANUAL BRICK HANDLING,Unplanned,HACKING STATION,-,2025-09-22 13:00,2025-09-22 13:20,20
9/22/25,KK200-1,OPERATIONAL,CLEANING,Planned - Included in OEE,DRYER,-,2025-09-22 14:00,2025-09-22 14:30,30
`;
const OEE = `﻿shiftDate,OEE,Availability,Performance,Quality,Sumof goodProductionTimeSec,Sum of slowProductionTimeSec,Sumof plannedTime,Sumof idealProductionQuantity,Sum of plannedStopsTimeSec,Sum of unplannedStopsTimeSec,Sum of goodQty,Sum of totalQty
9/22/25,0.72,0.8,0.92,0.98,1,1,28800,1,1,1,1,1
`;

function convertFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-'));
  fs.writeFileSync(path.join(dir, 'd.csv'), DOWNTIME);
  fs.writeFileSync(path.join(dir, 'o.csv'), OEE);
  return convertPeriod(path.join(dir, 'd.csv'), path.join(dir, 'o.csv'));
}

test('벽돌 라인 변환: 작업일보로 읽히고 원본의 시간가동률·양품률·OEE가 그대로 나온다', () => {
  const r = convertFixture();
  assert.equal(r.days, 1);
  assert.equal(r.stops, 4); // 계획 정지(OEE 제외)는 빠진다
  const { format, days } = parseFile(r.csv);
  assert.equal(format, 'mes-csv');
  assert.equal(days[0].machineId, 'CLAY-LINE');
  assert.equal(days[0].stops.length, 4);
  // 사유 뒤에 정지 위치가 [ ] 로 붙는다 (위치가 '-'면 붙이지 않는다)
  assert.deepEqual(days[0].stops.map((s) => s.text), ['기계 고장 [절단기]', '품종 교체 [압출 프레스]', '벽돌 수작업 처리(자재 흐름) [적재 스테이션]', '청소 [건조기]']);
  // 가져올 때처럼 사유 글을 규칙으로 분류해서 붙인다
  const reasons = days[0].stops.map((s) => ({ machineId: 'CLAY-LINE', date: days[0].date, stopId: s.group, code: classifyByRules(s.text).code }));
  const a = analyzeDay(days[0], reasons);
  assert.ok(Math.abs(a.availability - 0.8) < 0.01, `시간가동률 ${a.availability}`);
  assert.ok(Math.abs(a.quality - 0.98) < 0.01, `양품률 ${a.quality}`);
  assert.ok(Math.abs(a.oee - 0.72) < 0.01, `OEE ${a.oee}`);
  assert.equal(a.stops.filter((s) => s.loss === 'unknown').length, 0);
  // 정지 시간은 원본 비율(30:20:20:30)대로 나뉜다
  const byLoss = Object.fromEntries(['breakdown', 'setup', 'waiting', 'other_stop'].map((k) => [k, Math.round(a.losses[k] / 60)]));
  assert.deepEqual(byLoss, { breakdown: 29, setup: 19, waiting: 19, other_stop: 29 });
});

test('벽돌 라인 변환: 한글 사유가 원본 그룹과 같은 손실로 분류된다', () => {
  const group = {
    breakdown: ['AUTOMATION FAILURE', 'MECHANICAL FAILURE', 'ELECTRICAL FAILURE', 'OTHER FAILURE', 'WIRE FAILURE'],
    waiting: ['MANUAL BRICK HANDLING', 'RACKS', 'RACK STARVATION', 'KILN CAR STARVATION', 'MATERIAL STARVATION', 'EXTRUSION DEFECTS', 'WATER SHORTAGE', 'CRACKED WIP BRICKS', 'WET WIP BRICKS', 'LACK OF OPERATORS'],
    setup: ['MATERIAL CHANGEOVER', 'OTHER CALIBRATION', 'WIRE ROLL REPLACEMENT', 'MOULD CHANGE', 'DIE CHANGE'],
    other_stop: ['CLEANING', 'GREASING', 'PLANNED MAINTENANCE', 'OTHER', 'METAL DETECTOR', 'QUALITY CONTROL'],
  };
  for (const [loss, stops] of Object.entries(group)) {
    for (const s of stops) assert.equal(reasonByCode(classifyByRules(STOP_KO[s]).code).loss, loss, `${s} → ${STOP_KO[s]}`);
  }
  // 사유 글에 작업일보 구분자(, / ·)가 들어가면 안 된다
  for (const ko of Object.values(STOP_KO)) assert.ok(!/[,/·\d]/.test(ko), ko);
});

test('벽돌 라인 변환: 위치는 분류에 영향을 주지 않는다 ([ ] 안은 분류에서 뺀다)', () => {
  // '건조기'의 '건조', '유압 승강기'의 '유압'처럼 분류 낱말이 든 위치가 있어도 사유대로 분류된다
  for (const [en, ko] of Object.entries(STOP_KO)) {
    const plain = classifyByRules(ko).code;
    for (const loc of Object.keys(LOC_KO)) assert.equal(classifyByRules(`${ko} [${locationLabel(loc)}]`).code, plain, `${en} @ ${loc}`);
  }
  for (const loc of Object.keys(LOC_KO)) assert.ok(!/[,/·[\]]/.test(locationLabel(loc)), loc);
  assert.equal(locationLabel('-'), '');
});

test('벽돌 라인은 실시간 현장·예시 파일 시뮬레이션에 들어가지 않는다', () => {
  assert.ok(MACHINES.some((m) => m.id === 'CLAY-LINE'));
  assert.ok(!SIM_MACHINES.some((m) => m.id === 'CLAY-LINE'));
  assert.equal(SIM_MACHINES.length, 3);
});
