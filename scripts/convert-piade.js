// 공개 데이터 변환: 포장기 상태·알람 기록(PIADE) → 이 서비스의 OPC UA JSON Lines
//
//   node scripts/convert-piade.js <raw_data.csv> [저장할 폴더] [--machine s_1] [--from 2021-02-08] [--days 5]
//
// 원본: "Packaging Industry Anomaly DEtection (PIADE) Dataset"
//       D. Tosato, E. Convento, C. Masiero, G. A. Susto, A. Beghi, Zenodo, 2022. https://doi.org/10.5281/zenodo.7071747 (CC BY 4.0)
//       이탈리아 포장기 5대(s_1~s_5)의 2020~2021년 상태 구간·알람 코드·투입/산출 카운터. 파일 raw_data.csv (약 49MB).
//
// 만들어지는 파일: piade_포장기_<시작>_<끝>.jsonl → "데이터 연결 > 내 파일 올리기". 설비는 config.js 의 PACK-01(포장기).
//
// 바꾸는 방법
//  - 고른 기계의 평일 N일만, 공장 현지 시각(이탈리아)으로 이 서비스의 계획 시간(08:00~12:00, 13:00~17:00)만 잘라 얹는다.
//    (시각 숫자를 그대로 쓰므로 화면의 08:00 은 현지 08:00 이다. 점심 12~13시에 만든 수량은 넣지 않는다)
//  - 상태: production·performance_loss → 가동(2), idle → 대기(1), downtime → 알람(3, 알람 코드),
//          scheduled_downtime → 계획 정지(4, "계획 정지")
//  - 생산 수량: 산출 카운터(po)를 1분마다 적는다. 구간 안에서는 고르게 나눈다.
//  - 원본에는 정지 사유가 없고 알람 코드만 있다. 가져오면 정지는 "사유 미입력", 알람 코드는 신호로 보인다.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { plannedWindows } from '../src/config.js';

const MACHINE = 'PACK-01';
const TZ = 'Europe/Rome';
const STATE = { production: 2, performance_loss: 2, idle: 1, downtime: 3, scheduled_downtime: 4 };

// 공장 현지 벽시계 (날짜, 하루 몇 초째)
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function localClock(epochSec) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(epochSec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, sec: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) + (epochSec % 1) };
}
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const pad = (n, w = 2) => String(n).padStart(w, '0');
// 현지 벽시계 숫자를 그대로 +09:00 로 적는다 → 이 서비스(한국 시각)가 같은 숫자로 읽는다
const stamp = (date, sec) => `${date}T${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(Math.floor(sec % 60))}.${pad(Math.round((sec % 1) * 1000) % 1000, 3)}+09:00`;

/** 원본 줄들(한 기계, 시간순) → OPC UA JSON Lines 와 요약 */
export function convertRows(rows, { dates, windows = plannedWindows() }) {
  const want = new Set(dates);
  const out = [];
  let seq = 0;
  const push = (date, sec, payload) => {
    seq++;
    out.push(JSON.stringify({ MessageId: `${MACHINE}-${seq}`, MessageType: 'ua-data', PublisherId: `${MACHINE}-GW`, Messages: [{ DataSetWriterId: 1, SequenceNumber: seq, Timestamp: stamp(date, sec), Payload: payload }] }));
  };
  const stats = { stops: 0, alarms: new Set() };
  let counter = 0; // 계획 시간 안에서 만든 수량만 쌓는 카운터
  let counterDate = null;
  for (let i = 0; i < rows.length - 1; i++) {
    const r = rows[i];
    const next = rows[i + 1];
    const s = Number(r.start);
    const e = Number(r.end);
    const a = localClock(s);
    const b = localClock(e);
    if (!want.has(a.date) && !want.has(b.date)) continue;
    // 하루 경계를 넘는 구간은 시작 날짜 기준으로만 쓴다 (근무 시간 안에서는 거의 없다)
    if (a.date !== b.date && !want.has(a.date)) continue;
    const date = a.date;
    if (date !== counterDate) { counterDate = date; counter = 0; }
    const endSec = a.date === b.date ? b.sec : 86400;
    const st = STATE[r.type] ?? 1;
    const alarm = r.type === 'downtime' ? (r.alarm !== 'A_000' ? r.alarm : '') : r.type === 'scheduled_downtime' ? '계획 정지' : '';
    // 산출 카운터: 구간 시작값(r.po) → 끝값(next.po)을 시각에 비례해 나눈다
    const po0 = Number(r.po);
    const po1 = Math.max(po0, Number(next.po));
    const at = (sec) => po0 + ((po1 - po0) * (sec - a.sec)) / Math.max(1, endSec - a.sec);
    let counted = false;
    for (const w of windows) {
      const from = Math.max(a.sec, w.start);
      const to = Math.min(endSec, w.end);
      if (to <= from) continue;
      if (!counted && st !== 2) { stats.stops++; if (alarm && r.type === 'downtime') stats.alarms.add(alarm); counted = true; }
      const base = counter;
      const val = (t) => Math.round(base + at(t) - at(from));
      push(date, from, { MachineState: { Value: st }, AlarmText: { Value: alarm }, ShotCounter: { Value: val(from) } });
      for (let t = Math.ceil(from / 60) * 60; t < to; t += 60) if (t > from) push(date, t, { ShotCounter: { Value: val(t) } });
      push(date, to, { ShotCounter: { Value: val(to) } });
      counter = base + at(to) - at(from);
    }
  }
  const meta = JSON.stringify({ MessageId: `meta-${MACHINE}`, MessageType: 'ua-metadata', PublisherId: `${MACHINE}-GW`, DataSetWriterId: 1,
    MetaData: { Name: `${MACHINE}.Status`, Description: 'PIADE (Zenodo 7071747, CC BY 4.0) → 변환', Fields: [
      { Name: 'MachineState', DataType: 'Int32', Description: '0=Off 1=Idle 2=Running 3=Alarm 4=Setup/Planned stop' },
      { Name: 'AlarmText', DataType: 'String', Description: '원본 알람 코드 (A_xxx)' },
      { Name: 'ShotCounter', DataType: 'UInt32', Description: '원본 산출 카운터(po)' },
    ] } });
  return { jsonl: [meta, ...out].join('\n') + '\n', messages: out.length, stops: stats.stops, alarms: stats.alarms.size };
}

/** 시작일부터 평일 N일 */
export function weekdaysFrom(from, n) {
  const out = [];
  let d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const iso = d.toISOString().slice(0, 10);
    if (![0, 6].includes(weekday(iso))) out.push(iso);
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

async function readMachineRows(file, machine, fromSec, toSec) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = null;
  const rows = [];
  for await (const line of rl) {
    if (!header) { header = line.split(','); continue; }
    const c = line.split(',');
    if (c[1] !== machine) continue;
    const r = Object.fromEntries(header.map((h, i) => [h, c[i]]));
    const s = Number(r.start);
    if (s < fromSec - 86400 || s > toSec + 86400) continue;
    rows.push(r);
  }
  return rows.sort((x, y) => Number(x.start) - Number(y.start));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const pos = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const [file, outArg] = pos;
  if (!file) {
    console.error('사용법: node scripts/convert-piade.js <raw_data.csv> [저장할 폴더] [--machine s_1] [--from 2021-02-08] [--days 5]');
    process.exit(1);
  }
  const machine = opt('machine', 's_1');
  const dates = weekdaysFrom(opt('from', '2021-02-08'), Number(opt('days', 5)));
  const fromSec = Date.parse(`${dates[0]}T00:00:00Z`) / 1000;
  const toSec = Date.parse(`${dates.at(-1)}T23:59:59Z`) / 1000;
  const rows = await readMachineRows(file, machine, fromSec, toSec);
  const r = convertRows(rows, { dates });
  const outDir = path.resolve(outArg ?? path.dirname(file));
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `piade_포장기_${dates[0]}_${dates.at(-1)}.jsonl`);
  fs.writeFileSync(out, r.jsonl);
  console.log(`- 포장기(${machine}): ${dates[0]} ~ ${dates.at(-1)}, 평일 ${dates.length}일, 정지·대기 ${r.stops}구간, 알람 ${r.alarms}종 → ${out}`);
}
