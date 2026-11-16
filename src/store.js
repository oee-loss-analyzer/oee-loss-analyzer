// 저장소: 메모리에 두고 data/db.json 으로 저장 (프로토타입용. 실제 서비스에서는 DB로 교체)

import fs from 'node:fs';
import path from 'node:path';
import { analyzeDay } from './core/oee.js';

const DATA_DIR = path.resolve(process.env.OEE_DATA_DIR ?? 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export class Store {
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.days = new Map();      // `${machineId}|${date}` → DayRecord
    this.reasons = [];          // 정지 사유 기록
    this.questions = [];        // 작업자에게 보낸 질문
    this.imports = [];          // 가져온 파일 기록
    this.seq = 1;
    this._saveTimer = null;
    if (persist) this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      this.days = new Map(raw.days.map((d) => [`${d.machineId}|${d.date}`, d]));
      this.reasons = raw.reasons ?? [];
      this.questions = raw.questions ?? [];
      this.imports = raw.imports ?? [];
      this.seq = raw.seq ?? 1;
    } catch {
      /* 처음 실행 */
    }
  }

  save() {
    if (!this.persist) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const body = JSON.stringify({ days: [...this.days.values()], reasons: this.reasons, questions: this.questions, imports: this.imports, seq: this.seq });
      fs.writeFileSync(DB_FILE + '.tmp', body);
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    }, 500);
  }

  nextId(prefix) {
    return `${prefix}${this.seq++}`;
  }

  upsertDay(day, { silent = false } = {}) {
    this.days.set(`${day.machineId}|${day.date}`, day);
    if (!silent) this.save();
  }

  getDay(machineId, date) {
    return this.days.get(`${machineId}|${date}`) ?? null;
  }

  listDays({ from, to, machineId } = {}) {
    return [...this.days.values()]
      .filter((d) => (!from || d.date >= from) && (!to || d.date <= to) && (!machineId || d.machineId === machineId))
      .sort((a, b) => (a.date === b.date ? a.machineId.localeCompare(b.machineId) : a.date.localeCompare(b.date)));
  }

  dates() {
    return [...new Set([...this.days.values()].map((d) => d.date))].sort();
  }

  addReason(r) {
    // 같은 정지에 다시 답하면 덮어쓴다
    this.reasons = this.reasons.filter((x) => !(x.machineId === r.machineId && x.date === r.date && x.stopId === r.stopId));
    const rec = { id: this.nextId('R'), answeredAt: new Date().toISOString(), ...r };
    this.reasons.push(rec);
    this.save();
    return rec;
  }

  reasonsFor(machineId, date) {
    return this.reasons.filter((r) => r.machineId === machineId && r.date === date);
  }

  analyze({ from, to, machineId, untilByDay } = {}) {
    return this.listDays({ from, to, machineId }).map((d) =>
      analyzeDay(d, this.reasonsFor(d.machineId, d.date), { untilSec: untilByDay?.[`${d.machineId}|${d.date}`] }));
  }

  clear() {
    this.days.clear();
    this.reasons = [];
    this.questions = [];
    this.imports = [];
    this.save();
  }
}
