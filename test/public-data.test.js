import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertBottling } from '../scripts/convert-bottling.js';
import { convertRows, weekdaysFrom } from '../scripts/convert-piade.js';
import { parseFile } from '../src/ingest/parsers.js';
import { analyzeDay } from '../src/core/oee.js';
import { stripNotes } from '../src/reasons/classifier.js';

// 엑셀 날짜 일련번호: 44832 = 2022-09-28
const D = 44832;

test('충전 라인 변환: 같은 날 요약 두 줄을 더하고, 원본 가동 비율이 그대로 나온다', () => {
  const sheets = {
    // 3L 4시간 중 3시간 가동 + 5L 4시간 중 2시간 가동 → 8시간 중 5시간 (62.5%)
    daily_operation_summary: [
      { date: String(D), product_type_l: '3', production_units: '1500', monitored_time_dec: '4', operation_time_dec: '3' },
      { date: String(D), product_type_l: '5', production_units: '800', monitored_time_dec: '4', operation_time_dec: '2' },
      { date: String(D + 1), product_type_l: '3', production_units: '10', monitored_time_dec: '0.5', operation_time_dec: '0.4' }, // 1시간 미만 → 뺀다
    ],
    downtime_event_log: [
      { date: String(D), downtime_start_time: String(9 / 24), downtime_end_time: String(10 / 24), downtime_time: '1' },
      { date: String(D), downtime_start_time: String(14 / 24), downtime_end_time: String(16 / 24), downtime_time: '2' },
    ],
  };
  const r = convertBottling(sheets);
  assert.equal(r.days, 1);
  assert.equal(r.skipped, 1);
  const { format, days } = parseFile(r.csv);
  assert.equal(format, 'mes-csv');
  assert.equal(days[0].machineId, 'FILL-LINE');
  assert.equal(days[0].date, '2022-09-28');
  // 정지 시각은 [ ] 안에, 사유는 없다 → 분류할 글이 없어 "사유 미입력"
  assert.deepEqual(days[0].stops.map((s) => s.text), ['[09:00~10:00]', '[14:00~16:00]']);
  assert.ok(days[0].stops.every((s) => stripNotes(s.text) === ''));
  const a = analyzeDay(days[0], []);
  assert.ok(Math.abs(a.availability - 5 / 8) < 0.005, `시간가동률 ${a.availability}`);
  // 정지 시간은 원본 길이 비율(1:2)대로 나뉜다: 8시간 × 3/8 = 180분 → 60분 + 120분
  assert.deepEqual(days[0].stops.map((s) => s.dur / 60), [60, 120]);
  assert.equal(a.count, 2300); // 모니터링 8시간 = 근무 8시간이라 수량 그대로
  assert.equal(a.stops.filter((s) => s.loss === 'unknown').length, 2);
});

test('포장기 변환: 상태·알람이 OPC UA로 읽히고, 점심(12~13시) 수량은 빠진다', () => {
  const t = (h, m = 0) => Date.parse(`2021-02-08T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+01:00`) / 1000; // 이탈리아 겨울(UTC+1)
  const row = (type, from, to, po, alarm = 'A_000') => ({ equipment_ID: 's_1', type, alarm, start: String(from), end: String(to), po: String(po) });
  const rows = [
    row('production', t(7), t(10), 0),            // 07~10시: 3시간 × 1000개/시간
    row('downtime', t(10), t(10, 20), 3000, 'A_065'), // 20분 알람 정지
    row('production', t(10, 20), t(14), 3000),    // 10:20~14시 (점심 1시간 포함)
    row('scheduled_downtime', t(14), t(15), 6667),
    row('production', t(15), t(18), 6667),
    row('idle', t(18), t(19), 9667),
    row('production', t(19), t(20), 9667),        // 마지막 줄은 끝값만 쓴다
  ];
  const r = convertRows(rows, { dates: ['2021-02-08'] });
  const { format, days } = parseFile(r.jsonl);
  assert.equal(format, 'opcua');
  assert.equal(days[0].machineId, 'PACK-01');
  const a = analyzeDay(days[0], []);
  const hints = a.stops.map((s) => s.hint);
  assert.ok(hints.includes('알람 A_065'), hints.join('|'));
  assert.ok(hints.includes('계획 정지'), hints.join('|'));
  // 계획 시간(08~12, 13~17) 안의 수량: 08~10 2000 + 10:20~12 1667 + 13~14 1000 + 15~17 2000 ≈ 6667 (점심 1000개 제외)
  assert.ok(Math.abs(a.count - 6667) <= 3, `수량 ${a.count}`);
});

test('포장기 변환: 평일만 고른다', () => {
  assert.deepEqual(weekdaysFrom('2021-02-12', 3), ['2021-02-12', '2021-02-15', '2021-02-16']);
});

test('작업일보: 사유 끝의 "분" 숫자만 잘라 낸다 (사유 안의 같은 숫자는 남긴다)', () => {
  const csv = '﻿작업일자,설비코드,설비명,작업지시번호,품번,작업시작,작업종료,생산수량,양품수량,불량수량,비가동시간(분),비가동사유,작업자\n'
    + '2026-01-05,PRESS-01,x,w,p,08:00,17:00,10,10,0,70,"[15:56~15:59] 9, 기계 고장 [52번 라인] 52, 소재부족 9",-\n';
  const stops = parseFile(csv).days[0].stops;
  assert.deepEqual(stops.map((s) => [s.text, s.dur / 60]), [['[15:56~15:59]', 9], ['기계 고장 [52번 라인]', 52], ['소재부족', 9]]);
});
