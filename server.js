// OEE 손실 분석 서비스 서버 (외부 패키지 없이 Node 기본 기능만 사용)
//   npm start  →  http://localhost:4300

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MACHINES, REASONS, LOSS, SHIFT, DETECTION, FACTORY } from './src/config.js';
import { Store } from './src/store.js';
import { LiveEngine } from './src/live.js';
import { loadDemo } from './src/demo.js';
import { parseFile } from './src/ingest/parsers.js';
import { aggregate } from './src/core/oee.js';
import { hourlyLoss, reasonStats, machineStats, dailyTrend, findInsights, buildReport } from './src/core/insights.js';
import { classifyReason, llmEnabled, writeReportWithClaude, LLM_MODEL } from './src/reasons/classifier.js';
import { generateSamples } from './scripts/generate-samples.js';
import { todayLocal } from './src/core/time.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4300);
const PUBLIC = path.join(ROOT, 'public');
const SAMPLES = path.join(ROOT, 'sample-data');

const store = new Store();
const live = new LiveEngine(store);
if (!store.days.size || !store.listDays().some((d) => !d.live)) loadDemo(store);
if (!fs.existsSync(path.join(SAMPLES, 'index.json'))) generateSamples(SAMPLES);

// ---------- 실시간 알림 (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
let lastTick = 0;
live.on('update', (e) => {
  const now = Date.now();
  if (e.type === 'tick' && now - lastTick < 180) return;
  lastTick = now;
  broadcast('live', liveState());
});
live.on('question', (q) => broadcast('question', q));

function liveState() {
  return { ...live.snapshot(), questions: store.questions.filter((q) => q.date === live.date && q.status === 'pending') };
}

// ---------- 분석 ----------
function resolveRange(q) {
  const dates = store.dates();
  const hist = dates.filter((d) => d !== live.date);
  if (q.preset === 'live') return { from: live.date, to: live.date };
  if (q.from && q.to) return { from: q.from, to: q.to };
  const n = q.preset === '2w' ? 10 : q.preset === '1d' ? 1 : 5;
  const sel = hist.slice(-n);
  return { from: sel[0] ?? live.date, to: sel.at(-1) ?? live.date };
}

function analysis(q) {
  const { from, to } = resolveRange(q);
  const results = store.analyze({ from, to, machineId: q.machine || undefined });
  const dayMap = new Map(store.listDays({ from, to }).map((d) => [`${d.machineId}|${d.date}`, d]));
  const total = aggregate(results);
  return {
    range: { from, to }, total,
    machines: machineStats(results),
    hourly: hourlyLoss(results, dayMap),
    reasons: reasonStats(results),
    trend: dailyTrend(results),
    insights: findInsights(results, dayMap),
    warnings: [...new Set(results.flatMap((r) => r.warnings))],
    sources: [...new Set(results.map((r) => r.source))],
    stops: results.flatMap((r) => r.stops.map((s) => ({ ...s, machineId: r.machineId, date: r.date })))
      .sort((a, b) => (a.date === b.date ? (b.start ?? 0) - (a.start ?? 0) : b.date.localeCompare(a.date))).slice(0, 3000),
    days: results.map((r) => ({ machineId: r.machineId, date: r.date, source: r.source, oee: r.oee, availability: r.availability, performance: r.performance, quality: r.quality, count: r.count, defectCount: r.defectCount, untilSec: r.untilSec })),
    timelines: from === to ? store.listDays({ from, to }).map((d) => ({ machineId: d.machineId, timeline: d.timeline, untilSec: d.untilSec })) : [],
  };
}

function report(q) {
  const { from, to } = resolveRange(q);
  const dates = store.dates().filter((d) => d !== live.date);
  const inRange = dates.filter((d) => d >= from && d <= to);
  const before = dates.filter((d) => d < from).slice(-inRange.length);
  const results = store.analyze({ from, to });
  const prevResults = before.length ? store.analyze({ from: before[0], to: before.at(-1) }) : [];
  const dayMap = new Map(store.listDays({ from, to }).map((d) => [`${d.machineId}|${d.date}`, d]));
  return buildReport(results, dayMap, { prevResults, from, to });
}

// ---------- HTTP ----------
const routes = {
  'GET /api/config': () => ({
    factory: FACTORY, machines: MACHINES, reasons: REASONS, loss: LOSS, shift: SHIFT, detection: DETECTION,
    llm: { enabled: llmEnabled(), model: llmEnabled() ? LLM_MODEL : null }, dates: store.dates(), liveDate: live.date,
  }),
  'GET /api/live': () => liveState(),
  'POST /api/live/start': () => { live.start(); return liveState(); },
  'POST /api/live/pause': () => { live.pause(); return liveState(); },
  'POST /api/live/reset': () => { live.reset(); return liveState(); },
  'POST /api/live/settings': (b) => {
    if (b.speed) live.speed = Math.max(1, Math.min(600, Number(b.speed)));
    if (b.autoAnswer != null) live.autoAnswer = Boolean(b.autoAnswer);
    if (b.autoDefects != null) live.autoDefects = Boolean(b.autoDefects);
    return liveState();
  },
  'POST /api/live/inject': (b) => { live.inject(b.machineId, { code: b.code, minutes: Number(b.minutes) || 8 }); return liveState(); },
  'POST /api/live/defect': (b) => { live.addDefect(b.machineId, Number(b.n) || 1); return liveState(); },
  'POST /api/questions/answer': async (b) => live.answer(b.questionId, { code: b.code, text: b.text }),
  // 지난 정지에 사유를 나중에 입력 (가져온 데이터에는 사유가 비어 있다)
  'POST /api/stops/answer': async (b) => {
    const result = b.code ? { code: b.code, method: 'button', confidence: 1 } : await classifyReason(b.text ?? '', { hint: b.hint });
    return store.addReason({ machineId: b.machineId, date: b.date, stopId: b.stopId, start: b.start ?? null, code: result.code, text: b.text ?? null, method: result.method, confidence: result.confidence, summary: result.summary ?? null, by: 'manager' });
  },
  'POST /api/classify': async (b) => classifyReason(b.text ?? '', { hint: b.hint }),
  'GET /api/analysis': (_, q) => analysis(q),
  'GET /api/report': (_, q) => report(q),
  'POST /api/report/ai': async (b) => {
    if (!llmEnabled()) throw httpError(400, 'Claude API 키(ANTHROPIC_API_KEY)가 설정되지 않았습니다.');
    const r = report(b);
    return { text: await writeReportWithClaude(r.facts), template: r.text };
  },
  'POST /api/import': (b) => {
    const { format, days, defects } = parseFile(b.content ?? '', { format: b.format, filename: b.filename });
    for (const d of days) {
      const old = store.getDay(d.machineId, d.date);
      if (old?.defects?.length && !d.defects.length) { d.defects = old.defects; d.defectCount = old.defectCount; }
      store.upsertDay(d);
    }
    // 불량 기록 파일은 해당 설비·날짜의 불량을 통째로 바꾼다
    let attached = 0;
    const replaced = new Set();
    for (const df of defects) {
      const day = store.getDay(df.machineId, df.date);
      if (!day) continue;
      const key = `${df.machineId}|${df.date}`;
      if (!replaced.has(key)) { day.defects = []; replaced.add(key); }
      day.defects.push({ ts: df.ts, n: df.n });
      day.defectCount = day.defects.reduce((a, d) => a + d.n, 0);
      attached++;
    }
    const rec = { at: new Date().toISOString(), file: b.filename ?? '(붙여넣기)', format, days: days.length, defects: attached };
    store.imports.push(rec);
    store.save();
    return { ...rec, imported: days.map((d) => ({ machineId: d.machineId, date: d.date, stops: d.stops.length, count: d.count })) };
  },
  'GET /api/imports': () => store.imports.slice(-30).reverse(),
  'GET /api/samples': () => JSON.parse(fs.readFileSync(path.join(SAMPLES, 'index.json'), 'utf8')),
  'POST /api/demo/reload': () => {
    store.clear();
    const r = loadDemo(store, { today: todayLocal() });
    live.reset();
    return r;
  },
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8', '.svg': 'image/svg+xml' };

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function readBody(req, limit = 40 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, '파일이 너무 큽니다 (최대 40MB)');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: live\ndata: ${JSON.stringify(liveState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await handler(body, Object.fromEntries(url.searchParams));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }
    if (url.pathname.startsWith('/samples/') && serveFile(res, SAMPLES, decodeURIComponent(url.pathname.slice(9)))) return;
    if (serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(e.status ?? 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`OEE 손실 분석 서비스: http://localhost:${PORT}`);
  console.log(`사유 분류: ${llmEnabled() ? `Claude (${LLM_MODEL}) + 규칙 기반 백업` : '규칙 기반 (ANTHROPIC_API_KEY 를 설정하면 Claude 사용)'}`);
});
