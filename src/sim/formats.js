// 시뮬레이션 정답(ground truth) → 실제 산업 현장 데이터 형식으로 내보내기.
//
//  ct-csv     : 시판 전력·전류 측정기(CT) 로그. 1초 간격, 3상 전류·전압·전력
//  mtconnect  : CNC 표준 MTConnect Agent의 /sample 응답 (MTConnectStreams XML)
//  opcua      : OPC UA PubSub JSON 메시지 (JSON Lines). 사출기 EUROMAP 77 항목을 단순화
//  modbus-csv : Modbus TCP 게이트웨이 폴링 로그 (5초마다 레지스터 읽기)
//  mes-csv    : MES/POP 작업일보 엑셀 내보내기 (수기 입력 특유의 누락 포함)

import { SHIFT } from '../config.js';
import { toIsoLocal, toIsoUtc, hhmm } from '../core/time.js';
import { makeCurrentSampler } from './factory.js';
import { makeRng } from './random.js';

const ALARM_CODE = { 'E-203': 203, 'E-118': 118, 'E-077': 77, 'E-305': 305 };

// ---------- 1. 전류 센서 CSV ----------
export function encodeCtCsv(machine, truth) {
  const at = makeCurrentSampler(machine, truth);
  const lines = ['timestamp,device_id,channel,current_a,voltage_v,power_kw,pf'];
  const from = Math.max(SHIFT.start - 300, truth.startAt - 300);
  for (let s = from; s <= SHIFT.end + 300; s++) {
    const a = at(s);
    const pf = a > machine.idleCurrentA * 1.5 ? 0.86 : 0.42;
    const v = 380 + ((s * 7919) % 9) - 4;
    const kw = (Math.sqrt(3) * v * a * pf) / 1000;
    lines.push(`${toIsoLocal(truth.date, s)},${machine.id},L1,${a.toFixed(2)},${v},${kw.toFixed(2)},${pf}`);
  }
  return lines.join('\n') + '\n';
}

// 구간 경계마다 상태를 만들어 주는 공통 도우미
function stateChanges(truth) {
  const out = [];
  for (const seg of truth.segments) out.push({ t: seg.start, seg });
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ---------- 2. MTConnect Streams XML ----------
export function encodeMtconnect(machine, truth) {
  const events = [];
  const exec = (seg) => {
    if (seg.kind === 'RUN') return 'ACTIVE';
    if (seg.kind === 'MICRO') return 'FEED_HOLD';
    if (seg.kind === 'STOP' && seg.code === 'BREAKDOWN') return 'STOPPED';
    if (seg.kind === 'STOP' && seg.code === 'JAM') return 'INTERRUPTED';
    return 'READY';
  };
  const mode = (seg) => (seg.kind === 'STOP' && (seg.code === 'SETUP' || seg.code === 'ADJUST') ? 'MANUAL' : 'AUTOMATIC');
  const pre = Math.max(SHIFT.start - 600, truth.startAt - 600);
  events.push({ t: pre, tag: 'Availability', id: 'avail', value: 'AVAILABLE' });
  events.push({ t: pre, tag: 'Execution', id: 'exec', value: 'READY' });
  events.push({ t: pre, tag: 'ControllerMode', id: 'mode', value: 'AUTOMATIC' });
  let lastExec = 'READY';
  let lastMode = 'AUTOMATIC';
  let faultOpen = false;
  for (const { t, seg } of stateChanges(truth)) {
    const e = exec(seg);
    const m = mode(seg);
    if (m !== lastMode) { events.push({ t, tag: 'ControllerMode', id: 'mode', value: m }); lastMode = m; }
    if (e !== lastExec) { events.push({ t, tag: 'Execution', id: 'exec', value: e }); lastExec = e; }
    const stop = seg.kind === 'STOP' && seg.code === 'BREAKDOWN' ? truth.stops.find((s) => s.start === seg.start) : null;
    if (stop && !faultOpen) {
      const [code, ...rest] = stop.alarm.split(' ');
      events.push({ t, tag: 'Fault', id: 'logic_cond', cond: true, nativeCode: code, value: rest.join(' ') });
      faultOpen = true;
    } else if (!stop && faultOpen) {
      events.push({ t, tag: 'Normal', id: 'logic_cond', cond: true });
      faultOpen = false;
    }
  }
  events.push({ t: SHIFT.end + 60, tag: 'Execution', id: 'exec', value: 'STOPPED' });
  truth.cycles.forEach((c, i) => events.push({ t: c, tag: 'PartCount', id: 'pc', value: String(i + 1) }));
  events.sort((a, b) => a.t - b.t);

  const uuid = `${machine.id.toLowerCase()}-0001`;
  const ctrl = [];
  const cond = [];
  events.forEach((e, i) => {
    const attrs = `dataItemId="${e.id}" timestamp="${toIsoUtc(truth.date, e.t)}" sequence="${i + 1}"`;
    if (e.cond) {
      if (e.tag === 'Normal') cond.push(`            <Normal ${attrs} type="LOGIC_PROGRAM"/>`);
      else cond.push(`            <Fault ${attrs} type="LOGIC_PROGRAM" nativeCode="${e.nativeCode}">${xml(e.value)}</Fault>`);
    } else {
      ctrl.push(`            <${e.tag} ${attrs}>${xml(e.value)}</${e.tag}>`);
    }
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<MTConnectStreams xmlns="urn:mtconnect.org:MTConnectStreams:2.0">
  <Header creationTime="${toIsoUtc(truth.date, SHIFT.end + 120)}" sender="mtc-agent" instanceId="1700000000" version="2.0.0" bufferSize="131072" firstSequence="1" lastSequence="${events.length}" nextSequence="${events.length + 1}"/>
  <Streams>
    <DeviceStream name="${machine.id}" uuid="${uuid}">
      <ComponentStream component="Controller" name="controller" componentId="cont">
        <Events>
${ctrl.join('\n')}
        </Events>
        <Condition>
${cond.join('\n')}
        </Condition>
      </ComponentStream>
    </DeviceStream>
  </Streams>
</MTConnectStreams>
`;
}

// ---------- 3. OPC UA PubSub JSON (JSON Lines) ----------
// MachineState: 0=Off 1=Idle 2=Running 3=Alarm 4=Setup
export function encodeOpcuaJsonl(machine, truth) {
  const rng = makeRng(`${machine.id}|${truth.date}|opcua`);
  const ns = machine.id.replace('-', '');
  const lines = [];
  lines.push(JSON.stringify({
    MessageId: `meta-${truth.date}`, MessageType: 'ua-metadata', PublisherId: `${machine.id}-GW`, DataSetWriterId: 1,
    MetaData: {
      Name: `${machine.id}.Status`,
      Fields: [
        { Name: 'MachineState', DataType: 'Int32', NodeId: `ns=2;s=${ns}.MachineStatus.MachineState`, Description: '0=Off 1=Idle 2=Running 3=Alarm 4=Setup' },
        { Name: 'ShotCounter', DataType: 'UInt32', NodeId: `ns=2;s=${ns}.Production.ShotCounter` },
        { Name: 'AlarmText', DataType: 'String', NodeId: `ns=2;s=${ns}.MachineStatus.ActiveAlarm` },
        { Name: 'MotorCurrent', DataType: 'Float', NodeId: `ns=2;s=${ns}.Drive.MotorCurrent`, EngineeringUnits: 'A' },
      ],
    },
  }));
  const msgs = [];
  const stateOf = (seg) => {
    if (seg.kind === 'RUN') return 2;
    if (seg.kind === 'STOP' && seg.code === 'BREAKDOWN') return 3;
    if (seg.kind === 'STOP' && (seg.code === 'SETUP' || seg.code === 'ADJUST')) return 4;
    return 1;
  };
  let last = null;
  for (const { t, seg } of stateChanges(truth)) {
    const st = stateOf(seg);
    if (st === last) continue;
    last = st;
    const alarm = st === 3 ? truth.stops.find((s) => s.start === seg.start)?.alarm ?? '' : '';
    msgs.push({ t, payload: { MachineState: st, AlarmText: alarm, MotorCurrent: st === 2 ? machine.runCurrentA : machine.idleCurrentA } });
  }
  truth.cycles.forEach((c, i) => msgs.push({ t: c, payload: { ShotCounter: i + 1, MotorCurrent: +(machine.peakCurrentA * (1 + rng.normal(0, 0.03))).toFixed(2) } }));
  msgs.sort((a, b) => a.t - b.t);
  msgs.forEach((m, i) => {
    const ts = toIsoUtc(truth.date, m.t);
    const Payload = {};
    for (const [k, v] of Object.entries(m.payload)) Payload[k] = { Value: v, SourceTimestamp: ts };
    lines.push(JSON.stringify({
      MessageId: `${machine.id}-${truth.date}-${i + 1}`, MessageType: 'ua-data', PublisherId: `${machine.id}-GW`,
      Messages: [{ DataSetWriterId: 1, SequenceNumber: i + 1, Timestamp: ts, Payload }],
    }));
  });
  return lines.join('\n') + '\n';
}

// ---------- 4. Modbus 게이트웨이 폴링 로그 ----------
// 40001 운전상태(0=정지 1=운전 2=알람) / 40002~40003 생산 카운터(상위·하위 16비트) / 40010 알람코드
export function encodeModbusCsv(machine, truth, { pollSec = 5 } = {}) {
  const lines = ['timestamp,gateway,device_id,unit_id,function,register,value'];
  const unit = Number(machine.id.slice(-2));
  let segIdx = 0;
  let cycIdx = 0;
  const segs = truth.segments;
  const from = Math.max(SHIFT.start - 300, truth.startAt - 300);
  for (let t = from; t <= SHIFT.end + 300; t += pollSec) {
    while (segIdx < segs.length - 1 && segs[segIdx].end <= t) segIdx++;
    const seg = segs[segIdx];
    const inSeg = seg && t >= seg.start && t < seg.end;
    let status = 0;
    let alarm = 0;
    if (inSeg && seg.kind === 'RUN') status = 1;
    if (inSeg && seg.kind === 'STOP' && seg.code === 'BREAKDOWN') {
      status = 2;
      const stop = truth.stops.find((s) => s.start === seg.start);
      alarm = ALARM_CODE[stop?.alarm?.split(' ')[0]] ?? 999;
    }
    while (cycIdx < truth.cycles.length && truth.cycles[cycIdx] <= t) cycIdx++;
    const ts = toIsoLocal(truth.date, t);
    lines.push(`${ts},GW-01,${machine.id},${unit},3,40001,${status}`);
    lines.push(`${ts},GW-01,${machine.id},${unit},3,40002,${(cycIdx >>> 16) & 0xffff}`);
    lines.push(`${ts},GW-01,${machine.id},${unit},3,40003,${cycIdx & 0xffff}`);
    lines.push(`${ts},GW-01,${machine.id},${unit},3,40010,${alarm}`);
  }
  return lines.join('\n') + '\n';
}

// ---------- 5. MES/POP 작업일보 ----------
const MES_REASON_WORDS = {
  BREAKDOWN: ['설비고장', '고장수리', '알람'], SETUP: ['금형교체', '공구교체', '품번교체'], ADJUST: ['조정', '시사출'],
  MATERIAL: ['자재대기', '소재부족'], OPERATOR: ['인원부족', '교육'], JAM: ['걸림', '제품낌'], CLEAN: ['청소', '점검'], OTHER: ['기타'],
};
export function encodeMesCsv(machine, truth, { operator = '김OO' } = {}) {
  const rng = makeRng(`${machine.id}|${truth.date}|mes`);
  // 셋업 시작마다 작업지시가 바뀐다
  const bounds = [SHIFT.start, ...truth.stops.filter((s) => s.code === 'SETUP').map((s) => s.start), SHIFT.end];
  const rows = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const cycles = truth.cycles.filter((c) => c >= a && c < b).length;
    const defects = truth.defects.filter((d) => d.ts >= a && d.ts < b).length;
    // 수기 기록: 짧은 정지는 자주 빠뜨리고, 시간은 5분 단위로 반올림
    const parts = [];
    let downMin = 0;
    for (const s of truth.stops.filter((x) => x.start >= a && x.start < b)) {
      const min = (s.end - s.start) / 60;
      if (min < 6 && rng.chance(0.6)) continue;
      const r = Math.max(5, Math.round(min / 5) * 5);
      downMin += r;
      parts.push(`${rng.pick(MES_REASON_WORDS[s.code] ?? ['기타'])} ${r}`);
    }
    if (rng.chance(0.15) && parts.length) parts.pop(); // 사유를 아예 안 적은 날도 있다
    // 작업자는 사이클 카운터를 보고 끝자리를 반올림해서 적는다
    const produced = Math.round(cycles / 5) * 5;
    rows.push([
      truth.date, machine.id, machine.name, `WO-${truth.date.replaceAll('-', '')}-${machine.id.slice(-2)}${i + 1}`,
      `P-${1000 + Math.floor(rng.range(0, 900))}`, hhmm(a), hhmm(b), produced, produced - defects, defects,
      downMin, `"${parts.join(', ')}"`, operator,
    ].join(','));
  }
  return '﻿작업일자,설비코드,설비명,작업지시번호,품번,작업시작,작업종료,생산수량,양품수량,불량수량,비가동시간(분),비가동사유,작업자\n' + rows.join('\n') + '\n';
}

// 작업자 불량 입력 (카톡 [불량 +1] 버튼) → JSON
export function encodeDefectLog(machine, truth) {
  return truth.defects.map((d) => ({ machineId: machine.id, timestamp: toIsoLocal(truth.date, d.ts), count: d.n }));
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const FORMATS = {
  'ct-csv': { label: '전류 센서 CSV (CT, 1초)', ext: 'csv', encode: encodeCtCsv },
  mtconnect: { label: 'MTConnect Streams XML (CNC)', ext: 'xml', encode: encodeMtconnect },
  opcua: { label: 'OPC UA PubSub JSON Lines (사출기)', ext: 'jsonl', encode: encodeOpcuaJsonl },
  'modbus-csv': { label: 'Modbus TCP 폴링 로그 CSV', ext: 'csv', encode: encodeModbusCsv },
  'mes-csv': { label: 'MES/POP 작업일보 CSV', ext: 'csv', encode: encodeMesCsv },
};
