// 공개 데이터 변환: 벽돌 생산라인 OEE·정지 기록 → 이 서비스의 MES 작업일보 CSV
//
//   node scripts/convert-heavy-clay.js <내려받은 폴더> [저장할 폴더]
//
// 원본: "Overall Equipment Effectiveness and Downtime datasets in Heavy Clay production line"
//       Panos Ntoas, Zenodo, 2025. https://zenodo.org/records/17855209  (CC BY 4.0)
//       필요한 파일: DowntimeDataset.csv, OEEdataset.csv (개선 전), DowntimeDataset_afterLSS.csv, OEEdataset_afterLSS.csv (개선 후)
//
// 만들어지는 파일: heavy-clay_개선전_작업일보.csv, heavy-clay_개선후_작업일보.csv
//   → 화면의 "데이터 연결 > 내 파일 올리기"에 그대로 올린다. 설비는 config.js 의 CLAY-LINE(벽돌 라인).
//
// 바꾸는 방법
//  - 원본은 라인 전체의 교대(하루) 기록이다. 하루 = 작업일보 한 줄.
//  - 이 서비스는 하루 계획시간을 근무표(08:00~17:00, 점심 제외 8시간)로 계산하므로 원본을 8시간으로 환산한다.
//    · 정지 시간 합계는 원본 OEE 파일의 시간가동률이 그대로 나오도록 맞추고, 사유별로는 정지 목록의 비율대로 나눈다
//      (원본은 정지 목록 합계와 OEE 파일의 정지 시간이 어긋나는 날이 있어 OEE 파일을 기준으로 삼는다)
//    · 생산·양품 수량은 원본의 OEE·양품률이 그대로 나오도록 맞춘다
//  - "계획 정지 (OEE 제외)"(생산 계획 없음 등)는 원본처럼 계산에서 뺀다.
//  - 정지 사유는 한글로 바꿔 "비가동사유"에 "사유 [위치] 분" 형태로 적는다 (예: "기계 고장 [압출 프레스] 12").
//    가져올 때 사유 분류 규칙이 손실 종류를 정하고, [ ] 안의 위치는 분류에 쓰지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACHINES, SHIFT, plannedWindows } from '../src/config.js';

const LINE = MACHINES.find((m) => m.id === 'CLAY-LINE');

// 원본 사유 → 한글 사유. 분류 규칙이 원본 그룹과 같은 손실 종류로 읽도록 낱말을 고른다
// (예: MANUAL BRICK HANDLING 은 원본에서 자재 그룹이라 "자재"를 넣는다)
export const STOP_KO = {
  'AUTOMATION FAILURE': '자동화 장치 고장', 'MECHANICAL FAILURE': '기계 고장', 'ELECTRICAL FAILURE': '전기 고장',
  'OTHER FAILURE': '기타 고장', 'WIRE FAILURE': '절단 와이어 고장',
  'MANUAL BRICK HANDLING': '벽돌 수작업 처리(자재 흐름)', RACKS: '랙 문제(자재 흐름)', 'RACK STARVATION': '랙 부족(자재 대기)',
  'KILN CAR STARVATION': '소성차 부족(자재 대기)', 'MATERIAL STARVATION': '원료 부족', 'EXTRUSION DEFECTS': '압출 불량(원료)',
  'WATER SHORTAGE': '용수 부족(자재 대기)', 'CRACKED WIP BRICKS': '공정 중 벽돌 균열(자재)', 'WET WIP BRICKS': '공정 중 벽돌 젖음(자재)',
  'MATERIAL CHANGEOVER': '품종 교체', 'OTHER CALIBRATION': '기타 조정', 'WIRE ROLL REPLACEMENT': '와이어 롤 교체',
  'MOULD CHANGE': '금형 교체', 'DIE CHANGE': '다이 교체',
  CLEANING: '청소', GREASING: '주유', 'PLANNED MAINTENANCE': '계획 점검', OTHER: '기타',
  'LACK OF OPERATORS': '작업자 부족', 'METAL DETECTOR': '금속 검출기 정지', 'QUALITY CONTROL': '품질 검사', 'ΕΛΕΓΧΟΣ ΠΟΙΟΤΗΤΑΣ': '품질 검사',
};
// 정지 위치 (라인 안의 공정·장치). 원본에 그리스어로 적힌 것도 있다
export const LOC_KO = {
  'EXTRUDER PRESS': '압출 프레스', 'HACKING STATION': '적재 스테이션', 'DE-HACKING STATION': '하역 스테이션', DRYER: '건조기', CUTTER: '절단기',
  'HYDRAULIC ELEVATOR (UNLOADING)': '유압 승강기(하역)', 'HYDRAULIC ELEVATOR (LOADING)': '유압 승강기(적재)', SILO: '사일로',
  'SCREEN FEEDER': '스크린 피더', 'BOX FEEDERS': '박스 피더', 'CONVAYOR BELTS': '컨베이어 벨트', KILN: '소성로',
  'KILN CAR TRANSPORTER (EXIT)': '소성차 이송기(출구)', 'EMPTY RACK TRANSPORTER': '빈 랙 이송기', 'ΜΕΤΑΦΟΡΕΑΣ ΑΔΕΙΩΝ ΤΕΛΑΡΩΝ': '빈 랙 이송기',
  'MIDDLE RACK TRANSPORTER': '중간 랙 이송기', 'ΕΝΔΙΑΜΕΣΟΣ ΜΕΤΑΦΟΡΕΑΣ ΤΕΛΑΡΩΝ': '중간 랙 이송기', 'LINE 52': '52번 라인',
  PACKAGING: '포장', 'PAN MILL': '팬 밀', 'ROBOT (EXTRUDER PRESS)': '로봇(압출 프레스)', 'ROBOT (HACKING STATION)': '로봇(적재 스테이션)',
  'ROLLER MILL A': '롤러 밀 A', 'ROLLER MILL B': '롤러 밀 B', 'ROLLER MILL C': '롤러 밀 C',
};
export function locationLabel(loc) {
  const l = String(loc ?? '').trim();
  if (!l || l === '-') return '';
  // 작업일보 구분자( , / · )는 쓰지 않는다
  return (LOC_KO[l] ?? l).replace(/[,/·\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

// 표에 없는 사유는 원본 그룹으로 정한다
const GROUP_KO = { FAILURE: '기타 고장', MATERIALS: '자재 문제', 'SETUPS-CHANGEOVERS': '기타 교체', OPERATIONAL: '기타' };

export function stopLabel(group, stop) {
  return STOP_KO[stop] ?? GROUP_KO[group] ?? '기타';
}

// 따옴표가 들어간 CSV 한 줄
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.replace(/,/g, '').trim());
  const header = splitCsv(lines.shift());
  const n = header.filter(Boolean).length; // 원본 일부 파일은 뒤에 빈 칸이 수백 개 붙어 있다
  return lines.map((l) => splitCsv(l).slice(0, n)).map((c) => Object.fromEntries(header.slice(0, n).map((h, i) => [h, c[i] ?? ''])));
}

const col = (row, re) => row[Object.keys(row).find((k) => re.test(k))];
const mdyToIso = (s) => {
  const [m, d, y] = s.split('/').map(Number);
  return `${y < 100 ? 2000 + y : y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const hhmm = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

/** 원본 두 파일 → 작업일보 CSV 문자열과 요약 */
export function convertPeriod(downtimeFile, oeeFile) {
  const planned = plannedWindows().reduce((a, w) => a + (w.end - w.start), 0); // 이 서비스의 하루 계획시간 (초)
  const oee = new Map();
  for (const r of readCsv(oeeFile)) {
    oee.set(mdyToIso(col(r, /shiftDate/i)), {
      plannedSec: Number(col(r, /plannedTime/i)), oee: Number(col(r, /^OEE$/)), quality: Number(col(r, /^Quality$/)),
      availability: Number(col(r, /^Availability$/)),
    });
  }
  const byDate = new Map();
  let skipped = 0;
  for (const r of readCsv(downtimeFile)) {
    const start = col(r, /start/i);
    const type = col(r, /type/i);
    const date = start.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (/not included/i.test(type)) continue; // 계획 정지 (OEE 제외)
    if (!oee.has(date)) { skipped++; continue; }
    if (!byDate.has(date)) byDate.set(date, { products: [], stops: [] });
    const g = byDate.get(date);
    const prod = col(r, /product/i);
    if (prod && !g.products.includes(prod)) g.products.push(prod);
    const where = locationLabel(col(r, /location/i));
    g.stops.push({ label: `${stopLabel(col(r, /group/i), col(r, /^stop$/i))}${where ? ` [${where}]` : ''}`, min: Number(col(r, /duration/i)) || 0 });
  }
  const header = '작업일자,설비코드,설비명,작업지시번호,품번,작업시작,작업종료,생산수량,양품수량,불량수량,비가동시간(분),비가동사유,작업자';
  const rows = [];
  for (const date of [...byDate.keys()].sort()) {
    const g = byDate.get(date);
    const o = oee.get(date);
    if (!o.plannedSec) continue;
    // 그날 정지 시간 합계 = 8시간 × (1 − 원본 시간가동률). 정지 하나하나는 원본 길이 비율대로 나눠 "사유 분"으로 적는다
    const targetMin = Math.round((planned / 60) * (1 - Math.min(1, Math.max(0, o.availability))));
    const rawMin = g.stops.reduce((a, s) => a + s.min, 0);
    const k = rawMin ? targetMin / rawMin : 0;
    let left = Math.floor(planned / 60);
    const parts = [];
    for (const s of g.stops) {
      const m = Math.min(left, Math.max(1, Math.round(s.min * k)));
      if (m <= 0) break;
      parts.push(`${s.label} ${m}`);
      left -= m;
    }
    const good = Math.round((o.oee * planned) / LINE.idealCycleSec);
    const total = o.quality > 0 ? Math.round(good / o.quality) : good;
    const downMin = Math.floor(planned / 60) - left;
    rows.push([date, LINE.id, LINE.name, `CLAY-${date}`, g.products.join(' '), hhmm(SHIFT.start), hhmm(SHIFT.end),
      total, good, total - good, downMin, parts.join(', '), '-'].map(csvCell).join(','));
  }
  const dates = [...byDate.keys()].sort();
  return { csv: `﻿${header}\n${rows.join('\n')}\n`, days: rows.length, from: dates[0], to: dates.at(-1), stops: [...byDate.values()].reduce((a, g) => a + g.stops.length, 0), skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inDir, outArg] = process.argv.slice(2);
  if (!inDir) {
    console.error('사용법: node scripts/convert-heavy-clay.js <내려받은 폴더> [저장할 폴더]');
    process.exit(1);
  }
  const outDir = path.resolve(outArg ?? inDir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [label, down, oeeFile] of [['개선전', 'DowntimeDataset.csv', 'OEEdataset.csv'], ['개선후', 'DowntimeDataset_afterLSS.csv', 'OEEdataset_afterLSS.csv']]) {
    const dFile = path.join(inDir, down);
    const oFile = path.join(inDir, oeeFile);
    if (!fs.existsSync(dFile) || !fs.existsSync(oFile)) { console.log(`- ${label}: ${down} 또는 ${oeeFile} 이 없어 건너뜁니다`); continue; }
    const r = convertPeriod(dFile, oFile);
    const out = path.join(outDir, `heavy-clay_${label}_작업일보.csv`);
    fs.writeFileSync(out, r.csv);
    console.log(`- ${label}: ${r.from} ~ ${r.to}, ${r.days}일, 정지 ${r.stops}건${r.skipped ? ` (OEE 기록이 없는 날의 정지 ${r.skipped}건 제외)` : ''} → ${out}`);
  }
}
