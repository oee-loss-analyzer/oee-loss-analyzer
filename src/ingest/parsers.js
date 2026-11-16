// 산업 데이터 형식 → 표준 DayRecord.  "데이터는 어디서든 받아오고, 분석은 우리가."

import { MACHINES, machineById, SHIFT } from '../config.js';
import { parseTimestamp, parseHhmm } from '../core/time.js';
import { buildDayFromStates, buildDayFromSummary, currentToEvents } from '../core/canonical.js';

export function detectFormat(text, filename = '') {
  const head = text.slice(0, 600).replace(/^﻿/, '');
  if (head.includes('<MTConnectStreams')) return 'mtconnect';
  if (head.trimStart().startsWith('{') && head.includes('MessageType')) return 'opcua';
  if (/^timestamp,device_id,channel,current_a/m.test(head)) return 'ct-csv';
  if (/^timestamp,gateway,device_id,unit_id,function,register,value/m.test(head)) return 'modbus-csv';
  if (head.startsWith('작업일자,')) return 'mes-csv';
  if (head.trimStart().startsWith('[') && head.includes('"count"')) return 'defects-json';
  throw new Error(`형식을 알 수 없는 파일입니다 (${filename || '이름 없음'}). 지원 형식: 전류 CSV, MTConnect XML, OPC UA JSONL, Modbus CSV, MES 작업일보 CSV`);
}

/** 파일 내용 → { days: DayRecord[], defects: [{machineId,date,ts,n}] , format } */
export function parseFile(text, { format, filename, machineId: forcedMachine } = {}) {
  const fmt = format && format !== 'auto' ? format : detectFormat(text, filename);
  switch (fmt) {
    case 'ct-csv': return { format: fmt, days: parseCtCsv(text, forcedMachine), defects: [] };
    case 'mtconnect': return { format: fmt, days: parseMtconnect(text, forcedMachine), defects: [] };
    case 'opcua': return { format: fmt, days: parseOpcua(text, forcedMachine), defects: [] };
    case 'modbus-csv': return { format: fmt, days: parseModbus(text, forcedMachine), defects: [] };
    case 'mes-csv': return { format: fmt, days: parseMes(text), defects: [] };
    case 'defects-json': return { format: fmt, days: [], defects: parseDefects(text) };
    default: throw new Error(`지원하지 않는 형식: ${fmt}`);
  }
}

function requireMachine(id) {
  const m = machineById(id);
  if (!m) throw new Error(`설정에 없는 설비 ID: ${id} (config.js 의 MACHINES 에 추가하세요)`);
  return m;
}

function splitLines(text) {
  return text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
}

// ---------- 전류 CSV ----------
export function parseCtCsv(text, forcedMachine) {
  const lines = splitLines(text);
  const header = lines.shift().split(',');
  const iTs = header.indexOf('timestamp');
  const iDev = header.indexOf('device_id');
  const iA = header.indexOf('current_a');
  const groups = new Map();
  for (const line of lines) {
    const c = line.split(',');
    const p = parseTimestamp(c[iTs]);
    if (!p) continue;
    const id = forcedMachine ?? c[iDev];
    const key = `${id}|${p.date}`;
    if (!groups.has(key)) groups.set(key, { machineId: id, date: p.date, samples: [] });
    groups.get(key).samples.push([p.sec, Number(c[iA])]);
  }
  return [...groups.values()].map((g) => {
    const m = requireMachine(g.machineId);
    g.samples.sort((a, b) => a[0] - b[0]);
    const { stateEvents, cycles } = currentToEvents(m, g.samples);
    return buildDayFromStates({ machineId: m.id, date: g.date, source: 'ct-csv', stateEvents, cycles, untilSec: Math.min(SHIFT.end, g.samples.at(-1)[0]) });
  });
}

// ---------- MTConnect ----------
export function parseMtconnect(text, forcedMachine) {
  const devices = [...text.matchAll(/<DeviceStream\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/DeviceStream>/g)];
  const out = [];
  for (const [, name, body] of devices) {
    const m = requireMachine(forcedMachine ?? name);
    const items = [];
    const re = /<(Execution|ControllerMode|PartCount|Fault|Normal|Warning)\b([^>]*?)(?:\/>|>([^<]*)<\/\1>)/g;
    for (const [, tag, attrs, value] of body.matchAll(re)) {
      const ts = /timestamp="([^"]+)"/.exec(attrs)?.[1];
      const p = ts && parseTimestamp(ts);
      if (!p) continue;
      items.push({ tag, ...p, value: (value ?? '').trim(), nativeCode: /nativeCode="([^"]+)"/.exec(attrs)?.[1] });
    }
    items.sort((a, b) => (a.date === b.date ? a.sec - b.sec : a.date < b.date ? -1 : 1));
    const byDate = new Map();
    for (const it of items) {
      if (!byDate.has(it.date)) byDate.set(it.date, []);
      byDate.get(it.date).push(it);
    }
    for (const [date, its] of byDate) {
      const stateEvents = [];
      const cycles = [];
      let mode = 'AUTOMATIC';
      let fault = null;
      let lastCount = null;
      for (const it of its) {
        if (it.tag === 'ControllerMode') mode = it.value;
        else if (it.tag === 'Fault') fault = `${it.nativeCode ?? ''} ${it.value}`.trim();
        else if (it.tag === 'Normal') fault = null;
        else if (it.tag === 'Execution') {
          const running = it.value === 'ACTIVE';
          let hint = null;
          if (!running) hint = fault ? `알람 ${fault}` : mode === 'MANUAL' ? '수동 모드 (셋업 가능성)' : `Execution=${it.value}`;
          stateEvents.push({ t: it.sec, running, hint });
        } else if (it.tag === 'PartCount') {
          const n = Number(it.value);
          if (lastCount != null && n > lastCount) for (let k = 0; k < n - lastCount; k++) cycles.push(it.sec);
          if (lastCount == null && n > 0 && it.sec >= SHIFT.start) cycles.push(it.sec);
          lastCount = n;
        }
      }
      // 알람이 Execution 변화보다 늦게 오면 힌트 보강
      for (const it of its.filter((x) => x.tag === 'Fault')) {
        const ev = [...stateEvents].reverse().find((e) => e.t <= it.sec + 2 && !e.running);
        if (ev) ev.hint = `알람 ${it.nativeCode ?? ''} ${it.value}`.trim();
      }
      out.push(buildDayFromStates({ machineId: m.id, date, source: 'mtconnect', stateEvents, cycles }));
    }
  }
  return out;
}

// ---------- OPC UA PubSub JSON ----------
export function parseOpcua(text, forcedMachine) {
  const groups = new Map();
  let publisherMachine = null;
  for (const line of splitLines(text)) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const pub = String(msg.PublisherId ?? '').replace(/-GW$/, '');
    if (msg.MessageType === 'ua-metadata') { publisherMachine = pub; continue; }
    if (msg.MessageType !== 'ua-data') continue;
    const machineId = forcedMachine ?? (pub || publisherMachine);
    for (const dm of msg.Messages ?? []) {
      const p = parseTimestamp(dm.Timestamp);
      if (!p) continue;
      const key = `${machineId}|${p.date}`;
      if (!groups.has(key)) groups.set(key, { machineId, date: p.date, rows: [] });
      groups.get(key).rows.push({ sec: p.sec, payload: dm.Payload ?? {} });
    }
  }
  return [...groups.values()].map((g) => {
    const m = requireMachine(g.machineId);
    g.rows.sort((a, b) => a.sec - b.sec);
    const stateEvents = [];
    const cycles = [];
    let lastShot = null;
    for (const r of g.rows) {
      const st = r.payload.MachineState?.Value;
      if (st != null) {
        const alarm = r.payload.AlarmText?.Value;
        const hint = st === 3 ? `알람 ${alarm || ''}`.trim() : st === 4 ? '셋업 모드' : st === 0 ? '전원 꺼짐' : null;
        stateEvents.push({ t: r.sec, running: st === 2, hint });
      }
      const shot = r.payload.ShotCounter?.Value;
      if (shot != null) {
        if (lastShot != null && shot > lastShot) for (let k = 0; k < shot - lastShot; k++) cycles.push(r.sec);
        if (lastShot == null) cycles.push(r.sec);
        lastShot = shot;
      }
    }
    return buildDayFromStates({ machineId: m.id, date: g.date, source: 'opcua', stateEvents, cycles });
  });
}

// ---------- Modbus 폴링 로그 ----------
export function parseModbus(text, forcedMachine) {
  const lines = splitLines(text);
  const header = lines.shift().split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const polls = new Map(); // key: machine|date|sec
  for (const line of lines) {
    const c = line.split(',');
    const p = parseTimestamp(c[idx.timestamp]);
    if (!p) continue;
    const machineId = forcedMachine ?? c[idx.device_id];
    const key = `${machineId}|${p.date}|${p.sec}`;
    if (!polls.has(key)) polls.set(key, { machineId, date: p.date, sec: p.sec, reg: {} });
    polls.get(key).reg[c[idx.register]] = Number(c[idx.value]);
  }
  const groups = new Map();
  for (const poll of polls.values()) {
    const k = `${poll.machineId}|${poll.date}`;
    if (!groups.has(k)) groups.set(k, { machineId: poll.machineId, date: poll.date, polls: [] });
    groups.get(k).polls.push(poll);
  }
  return [...groups.values()].map((g) => {
    const m = requireMachine(g.machineId);
    g.polls.sort((a, b) => a.sec - b.sec);
    const stateEvents = [];
    const cycles = [];
    let lastStatus = null;
    let prev = null;
    for (const poll of g.polls) {
      const status = poll.reg['40001'];
      if (status !== lastStatus) {
        const alarm = poll.reg['40010'];
        stateEvents.push({ t: poll.sec, running: status === 1, hint: status === 2 ? `알람 코드 ${alarm}` : null });
        lastStatus = status;
      }
      const count = ((poll.reg['40002'] ?? 0) << 16) + (poll.reg['40003'] ?? 0);
      if (prev && count > prev.count) {
        // 폴링 사이에 나온 제품은 그 구간에 고르게 나눠 놓는다
        const n = count - prev.count;
        for (let k = 1; k <= n; k++) cycles.push(prev.sec + ((poll.sec - prev.sec) * k) / n);
      }
      prev = { sec: poll.sec, count };
    }
    return buildDayFromStates({ machineId: m.id, date: g.date, source: 'modbus-csv', stateEvents, cycles });
  });
}

// ---------- MES 작업일보 ----------
export function parseMes(text) {
  const lines = splitLines(text);
  const header = parseCsvLine(lines.shift());
  const col = (name) => header.indexOf(name);
  const groups = new Map();
  for (const line of lines) {
    const c = parseCsvLine(line);
    const machineId = c[col('설비코드')];
    const date = c[col('작업일자')];
    const key = `${machineId}|${date}`;
    if (!groups.has(key)) groups.set(key, { machineId, date, rows: [] });
    groups.get(key).rows.push({
      start: parseHhmm(c[col('작업시작')]), end: parseHhmm(c[col('작업종료')]),
      produced: Number(c[col('생산수량')]) || 0, defects: Number(c[col('불량수량')]) || 0,
      downMin: Number(c[col('비가동시간(분)')]) || 0, reason: c[col('비가동사유')] ?? '',
    });
  }
  return [...groups.values()].map((g) => {
    requireMachine(g.machineId);
    const downtimes = [];
    for (const r of g.rows) {
      // "자재대기 15, 걸림 5" → 사유별로 나눈다. 숫자가 없으면 남은 시간을 나눠 준다
      const parts = r.reason.split(/[,/·]/).map((s) => s.trim()).filter(Boolean);
      let used = 0;
      const noMin = [];
      for (const part of parts) {
        const mm = /(\d+)\s*분?$/.exec(part);
        if (mm) {
          downtimes.push({ dur: Number(mm[1]) * 60, text: part.replace(mm[0], '').trim() });
          used += Number(mm[1]);
        } else noMin.push(part);
      }
      const rest = Math.max(0, r.downMin - used);
      if (rest > 0) {
        if (noMin.length) noMin.forEach((t) => downtimes.push({ dur: (rest * 60) / noMin.length, text: t }));
        else downtimes.push({ dur: rest * 60, text: '' });
      }
    }
    return buildDayFromSummary({
      machineId: g.machineId, date: g.date, source: 'mes-csv', downtimes,
      count: g.rows.reduce((s, r) => s + r.produced, 0),
      defectCount: g.rows.reduce((s, r) => s + r.defects, 0),
      workStart: Math.min(...g.rows.map((r) => r.start ?? SHIFT.start)),
      workEnd: Math.max(...g.rows.map((r) => r.end ?? SHIFT.end)),
    });
  });
}

function parseDefects(text) {
  const arr = JSON.parse(text);
  return arr.map((d) => {
    const p = parseTimestamp(d.timestamp);
    return p ? { machineId: d.machineId, date: p.date, ts: p.sec, n: d.count ?? 1 } : null;
  }).filter(Boolean);
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export const KNOWN_MACHINES = MACHINES.map((m) => m.id);
