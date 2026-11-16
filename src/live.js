// 실시간 모드: 오늘 하루를 빨리 감기로 돌리면서 전류 센서 데이터를 1초씩 흘려보낸다.
// 설비가 2분 넘게 멈추면 작업자에게 "왜 멈췄나요?" 질문을 만든다.

import { EventEmitter } from 'node:events';
import { MACHINES, SHIFT, DETECTION } from './config.js';
import { simulateDay, makeCurrentSampler, UTTERANCES } from './sim/factory.js';
import { buildDayFromStates } from './core/canonical.js';
import { classifyByRules, classifyReason } from './reasons/classifier.js';
import { makeRng } from './sim/random.js';
import { todayLocal } from './core/time.js';

const TICK_MS = 200;

export class LiveEngine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.speed = 60;           // 실제 1초 = 공장 60초
    this.autoAnswer = false;   // 작업자 대신 자동으로 답하기
    this.autoDefects = true;   // 시뮬레이션 불량을 자동 입력
    this.timer = null;
    this.rng = makeRng(`live|${Date.now()}`);
    this.reset();
  }

  reset({ date } = {}) {
    this.pause();
    this.date = date ?? todayLocal();
    this.simSec = SHIFT.start - 60;
    this.carry = 0;
    this.ended = false;
    this.machines = MACHINES.map((m) => {
      const truth = simulateDay(m, this.date, { seed: `live|${m.id}|${this.date}|${Math.floor(this.rng.next() * 1e9)}` });
      return {
        machine: m, truth, sampler: makeCurrentSampler(m, truth, 'live'),
        stateEvents: [], cycles: [], defects: [],
        running: null, above: false, lastPeak: -Infinity, current: 0,
        stopStart: null, asked: new Set(), pendingAuto: [],
      };
    });
    this.store.questions = this.store.questions.filter((q) => q.date !== this.date);
    this.store.reasons = this.store.reasons.filter((r) => r.date !== this.date);
    for (const m of MACHINES) this.store.days.delete(`${m.id}|${this.date}`);
    this.store.save();
    this.emit('update', { type: 'reset' });
  }

  start() {
    if (this.timer || this.ended) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit('update', { type: 'status' });
  }

  pause() {
    clearInterval(this.timer);
    this.timer = null;
    this.emit?.('update', { type: 'status' });
  }

  get isRunning() {
    return Boolean(this.timer);
  }

  tick() {
    // 배속이 낮으면(×1 등) 한 틱에 1초가 안 될 수 있어 남은 시간을 모아 둔다
    this.carry = (this.carry ?? 0) + (this.speed * TICK_MS) / 1000;
    while (this.carry >= 1 && this.simSec < SHIFT.end) {
      this.carry -= 1;
      this.simSec += 1;
      for (const st of this.machines) this.step(st, this.simSec);
    }
    for (const st of this.machines) this.flush(st);
    if (this.simSec >= SHIFT.end) {
      this.ended = true;
      this.pause();
      for (const q of this.store.questions.filter((x) => x.date === this.date && x.status === 'pending')) q.status = 'expired';
      this.store.save();
    }
    this.emit('update', { type: 'tick' });
  }

  step(st, sec) {
    const m = st.machine;
    const a = st.sampler(sec);
    st.current = a;
    const running = a >= m.runCurrentA * DETECTION.runRatio;
    if (running !== st.running) {
      st.stateEvents.push({ t: sec, running, hint: !running && a < m.idleCurrentA * 0.4 ? '전원 꺼짐 (전류 거의 0)' : null });
      st.running = running;
      st.stopStart = running ? null : sec;
    }
    const peakTh = m.runCurrentA + (m.peakCurrentA - m.runCurrentA) * DETECTION.peakRatio;
    const above = a >= peakTh;
    if (above && !st.above && sec - st.lastPeak >= m.idealCycleSec * 0.5) {
      st.cycles.push(sec);
      st.lastPeak = sec;
    }
    st.above = above;
    if (this.autoDefects) for (const d of st.truth.defects) if (d.ts === sec) st.defects.push({ ts: sec, n: 1 });

    // 자동 답변 예약 처리
    for (const p of st.pendingAuto.filter((x) => x.at <= sec)) {
      st.pendingAuto = st.pendingAuto.filter((x) => x !== p);
      const q = this.store.questions.find((x) => x.id === p.questionId);
      if (q && q.status === 'pending') this.answer(q.id, { text: p.text, by: 'auto', noLlm: true });
    }
  }

  // 질문은 원시 전류가 아니라 "정리된 정지"(1분 미만 무시, 셋업 중 조그 합침) 기준으로 만든다.
  // 그래야 금형 교체 중 잠깐 시운전을 해도 같은 정지를 두 번 묻지 않는다.
  askIfNeeded(st, day) {
    for (const s of day.stops) {
      if (st.asked.has(s.group)) continue;
      if (s.end - s.start < DETECTION.askReasonAfterSec) continue;
      const first = day.stops.find((x) => x.group === s.group);
      st.asked.add(s.group);
      this.ask(st, first, this.simSec);
    }
  }

  ask(st, stop, nowSec) {
    const m = st.machine;
    const stopStart = stop.start;
    const truthStop = st.truth.stops.find((s) => stopStart >= s.start - 5 && stopStart < s.end) ??
      st.truth.stops.find((s) => s.start < stop.end && s.end > stopStart);
    const q = {
      id: this.store.nextId('Q'), machineId: m.id, machineName: m.name, date: this.date,
      stopId: stop.group, start: stopStart, askedAt: nowSec,
      hint: stop.hint ?? null, status: 'pending',
    };
    this.store.questions.push(q);
    if (this.autoAnswer) {
      const text = truthStop?.utterance ?? this.rng.pick(UTTERANCES.OTHER);
      st.pendingAuto.push({ questionId: q.id, at: nowSec + Math.round(this.rng.range(20, 180)), text });
    }
    this.emit('question', q);
  }

  async answer(questionId, { code, text, by = 'operator', noLlm = false }) {
    const q = this.store.questions.find((x) => x.id === questionId);
    if (!q) throw new Error('질문을 찾을 수 없습니다');
    let result;
    if (code) result = { code, method: 'button', confidence: 1 };
    else result = await classifyReason(text ?? '', { hint: q.hint, machineName: q.machineName, noLlm });
    q.status = 'answered';
    const rec = this.store.addReason({
      machineId: q.machineId, date: q.date, stopId: q.stopId, start: q.start, code: result.code, text: text ?? null,
      method: result.method, confidence: result.confidence, summary: result.summary ?? null, llmError: result.llmError ?? null, by,
    });
    this.emit('update', { type: 'answer', questionId, reason: rec });
    return rec;
  }

  addDefect(machineId, n = 1) {
    const st = this.machines.find((x) => x.machine.id === machineId);
    if (!st) throw new Error('설비를 찾을 수 없습니다');
    st.defects.push({ ts: this.simSec, n });
    this.flush(st);
    this.emit('update', { type: 'defect' });
  }

  /** 시연용: 지금 이 설비를 강제로 멈춘다 (남은 하루를 다시 시뮬레이션) */
  inject(machineId, { code = 'SETUP', minutes = 8 } = {}) {
    const st = this.machines.find((x) => x.machine.id === machineId);
    if (!st) throw new Error('설비를 찾을 수 없습니다');
    const now = Math.max(SHIFT.start, Math.ceil(this.simSec) + 1);
    const rest = simulateDay(st.machine, this.date, {
      seed: `inject|${machineId}|${now}|${Math.floor(this.rng.next() * 1e9)}`, startAt: now,
      forcedStops: [{ start: now, dur: minutes * 60, code }], initialStartup: false,
    });
    const t = st.truth;
    const keep = (arr, f) => arr.filter(f);
    const segs = keep(t.segments, (s) => s.start < now).map((s) => (s.end > now ? { ...s, end: now } : s));
    st.truth = {
      ...t,
      segments: [...segs, ...rest.segments].sort((a, b) => a.start - b.start),
      stops: [...keep(t.stops, (s) => s.start < now).map((s) => (s.end > now ? { ...s, end: now } : s)), ...rest.stops],
      cycles: [...keep(t.cycles, (c) => c < now), ...rest.cycles],
      defects: [...keep(t.defects, (d) => d.ts < now), ...rest.defects],
    };
    st.sampler = makeCurrentSampler(st.machine, st.truth, `live-${now}`);
    this.emit('update', { type: 'inject', machineId, code });
  }

  flush(st) {
    if (this.simSec < SHIFT.start) return;
    const day = buildDayFromStates({
      machineId: st.machine.id, date: this.date, source: 'live-ct',
      stateEvents: st.stateEvents.length ? st.stateEvents : [{ t: SHIFT.start, running: false }],
      cycles: st.cycles, defects: st.defects, untilSec: this.simSec,
    });
    day.live = true;
    st.day = day;
    this.store.upsertDay(day, { silent: true });
    this.askIfNeeded(st, day);
  }

  snapshot() {
    return {
      date: this.date, simSec: this.simSec, running: this.isRunning, ended: this.ended,
      speed: this.speed, autoAnswer: this.autoAnswer, autoDefects: this.autoDefects,
      shift: { start: SHIFT.start, end: SHIFT.end, breaks: SHIFT.plannedBreaks },
      machines: this.machines.map((st) => {
        // 진행 중인 정지: 정리된 정지 중 지금까지 이어지는 것
        const last = st.day?.stops.at(-1);
        const ongoing = last && last.end >= this.simSec - 1 ? st.day.stops.find((x) => x.group === last.group) : null;
        const inBreak = SHIFT.plannedBreaks.some((b) => this.simSec >= b.start && this.simSec < b.end);
        return {
          id: st.machine.id, name: st.machine.name, current: st.current,
          state: this.simSec < SHIFT.start ? 'OFF' : inBreak ? 'BREAK' : ongoing || !st.running ? 'STOP' : 'RUN',
          stopFor: ongoing ? this.simSec - ongoing.start : st.running || st.stopStart == null ? 0 : this.simSec - st.stopStart,
          count: st.cycles.length, defects: st.defects.reduce((a, d) => a + d.n, 0),
        };
      }),
    };
  }
}

export { classifyByRules };
