// 공개 데이터 변환: 음료 충전 라인 생산·정지 기록 → 이 서비스의 MES 작업일보 CSV
//
//   node scripts/convert-bottling.js <production_raw.xlsx> [저장할 폴더]
//
// 원본: "Industrial Production Time-Series Dataset from a Beverage Bottling Line"
//       G. A. David, P. M. de C. Monson, C. Soares Junior, Zenodo, 2026. https://doi.org/10.5281/zenodo.18146866 (CC BY 4.0)
//       브라질 주스 충전기(3L·5L 갤런)를 IIoT로 2022-07 ~ 2023-02 모니터링한 기록. 파일은 production_raw.xlsx 하나.
//
// 만들어지는 파일: bottling_작업일보.csv → "데이터 연결 > 내 파일 올리기". 설비는 config.js 의 FILL-LINE(충전 라인).
//
// 바꾸는 방법
//  - 하루 = 작업일보 한 줄. 같은 날 3L·5L을 모두 만든 날은 원본 요약이 두 줄이라 더해서 한 줄로 만든다.
//    모니터링이 1시간 미만인 날은 뺀다.
//  - 원본은 하루 모니터링 시간이 날마다 다르다(0.2~9.9시간). 이 서비스의 근무표(8시간)로 환산하되,
//    · 정지 시간 합계는 원본 일별 요약의 가동 비율(operation_time ÷ monitored_time)이 그대로 나오도록 맞추고
//      정지 기록 하나하나에 길이 비율대로 나눈다 (원본은 정지 기록 합과 일별 요약이 어긋나는 날이 있다)
//    · 생산 수량은 같은 비율(8시간 ÷ 원본 모니터링 시간)로 늘려 시간당 생산 속도를 그대로 둔다
//  - 원본에는 정지 사유가 없다. 정지마다 원본 시각만 "[13:05~13:09] 4"처럼 적어 두므로 가져오면 "사유 미입력"이 된다.
//  - 원본에는 불량 수량이 없어 불량은 0으로 둔다.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MACHINES, SHIFT, plannedWindows } from '../src/config.js';

const LINE = MACHINES.find((m) => m.id === 'FILL-LINE');

// ---------- xlsx 읽기 (라이브러리 없이: xlsx는 XML 묶음이라 unzip 으로 꺼낸다) ----------
function unzipText(file, inner) {
  try { return execFileSync('unzip', ['-p', file, inner], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return ''; }
}
export function readXlsx(file) {
  const ss = [...unzipText(file, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
  const wb = unzipText(file, 'xl/workbook.xml');
  const rels = unzipText(file, 'xl/_rels/workbook.xml.rels');
  if (!wb) throw new Error(`엑셀 파일을 읽지 못했습니다: ${file} (unzip 명령이 필요합니다)`);
  const colIdx = (ref) => [...ref.replace(/\d+/g, '')].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const sheets = {};
  for (const [, name, rid] of wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const rel = [...rels.matchAll(/<Relationship [^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`));
    const target = /Target="([^"]+)"/.exec(rel)[1].replace(/^\/?xl\//, '');
    const xml = unzipText(file, `xl/${target}`);
    const rows = [];
    for (const [, inner] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const r = [];
      for (const [, attrs, body] of inner.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)[1];
        const t = /t="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(body ?? '')?.[1] ?? '';
        r[colIdx(ref)] = t === 's' ? ss[Number(v)] : v;
      }
      rows.push(Array.from(r, (x) => x ?? ''));
    }
    const [header, ...data] = rows;
    sheets[name] = data.filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }
  return sheets;
}

// 엑셀 날짜(일련번호)·시각(하루의 비율)
const excelDate = (n) => new Date(Date.UTC(1899, 11, 30) + Number(n) * 86400000).toISOString().slice(0, 10);
const excelClock = (f) => {
  const s = Math.round(Number(f) * 86400);
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};
const hhmm = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// 정수 분으로 나누되 합계를 정확히 맞춘다 (가장 큰 나머지 순서로 1분씩 더 준다)
function splitMinutes(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || total <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

/** 원본 시트 → 작업일보 CSV와 요약 */
export function convertBottling(sheets, { minMonitoredH = 1 } = {}) {
  const planned = plannedWindows().reduce((a, w) => a + (w.end - w.start), 0); // 이 서비스의 하루 계획시간(초)
  const plannedMin = Math.floor(planned / 60);
  const events = new Map();
  for (const e of sheets.downtime_event_log ?? []) {
    const d = excelDate(e.date);
    if (!events.has(d)) events.set(d, []);
    events.get(d).push({ from: excelClock(e.downtime_start_time), to: excelClock(e.downtime_end_time), h: Number(e.downtime_time) || 0 });
  }
  const header = '작업일자,설비코드,설비명,작업지시번호,품번,작업시작,작업종료,생산수량,양품수량,불량수량,비가동시간(분),비가동사유,작업자';
  const rows = [];
  let stops = 0;
  let skipped = 0;
  // 같은 날 요약 줄은 더한다 (제품이 바뀐 날)
  const byDate = new Map();
  for (const s of sheets.daily_operation_summary ?? []) {
    const d = excelDate(s.date);
    const g = byDate.get(d) ?? { date: d, monitored: 0, operation: 0, units: 0, types: [] };
    g.monitored += Number(s.monitored_time_dec) || 0;
    g.operation += Number(s.operation_time_dec) || 0;
    g.units += Number(s.production_units) || 0;
    if (!g.types.includes(`${s.product_type_l}L`)) g.types.push(`${s.product_type_l}L`);
    byDate.set(d, g);
  }
  for (const s of [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const date = s.date;
    const monitored = s.monitored;
    const operation = Math.min(monitored, s.operation);
    if (monitored < minMonitoredH) { skipped++; continue; }
    const k = planned / 3600 / monitored; // 원본 모니터링 시간 → 8시간
    const downMin = Math.round(plannedMin * (1 - operation / monitored));
    const evs = (events.get(date) ?? []).filter((e) => e.h > 0);
    let parts = [];
    if (evs.length) {
      const mins = splitMinutes(evs.map((e) => e.h), downMin);
      parts = evs.map((e, i) => (mins[i] > 0 ? `[${e.from}~${e.to}] ${mins[i]}` : null)).filter(Boolean);
    } else if (downMin > 0) parts = [`[정지 기록 없음] ${downMin}`];
    stops += parts.length;
    const units = Math.round(s.units * k);
    rows.push([date, LINE.id, LINE.name, `FILL-${date}`, `${s.types.join(' ')} 갤런`, hhmm(SHIFT.start), hhmm(SHIFT.end),
      units, units, 0, downMin, parts.join(', '), '-'].map(csvCell).join(','));
  }
  const dates = rows.map((r) => r.slice(0, 10));
  return { csv: `﻿${header}\n${rows.join('\n')}\n`, days: rows.length, stops, skipped, from: dates[0], to: dates.at(-1) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [xlsx, outArg] = process.argv.slice(2);
  if (!xlsx) {
    console.error('사용법: node scripts/convert-bottling.js <production_raw.xlsx> [저장할 폴더]');
    process.exit(1);
  }
  const outDir = path.resolve(outArg ?? path.dirname(xlsx));
  fs.mkdirSync(outDir, { recursive: true });
  const r = convertBottling(readXlsx(xlsx));
  const out = path.join(outDir, 'bottling_작업일보.csv');
  fs.writeFileSync(out, r.csv);
  console.log(`- 충전 라인: ${r.from} ~ ${r.to}, ${r.days}일, 정지 ${r.stops}건${r.skipped ? ` (모니터링 1시간 미만 ${r.skipped}일 제외)` : ''} → ${out}`);
}
