// OEE 손실 분석 서비스 서버 (외부 패키지 없이 Node 기본 기능만 사용)
//   npm start  →  http://localhost:4300

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MACHINES, REASONS, LOSS, SHIFT, DETECTION, FACTORY } from './src/config.js';
import { Store } from './src/store.js';
import { LiveEngine } from './src/live.js';
import { listSamples, buildSampleText, sampleFileName, SAMPLE_FILES } from './src/sampleSets.js';
import { parseFile } from './src/ingest/parsers.js';
import { aggregate } from './src/core/oee.js';
import { hourlyLoss, reasonStats, machineStats, dailyTrend, findInsights, buildReport } from './src/core/insights.js';
import { classifyReason, llmEnabled, writeReportWithClaude, LLM_MODEL } from './src/reasons/classifier.js';
import { generateSamples } from './scripts/generate-samples.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4300);
const PUBLIC = path.join(ROOT, 'public');
const SAMPLES = path.join(ROOT, 'sample-data');

const store = new Store();
const live = new LiveEngine(store);
// 데모 데이터는 자동으로 넣지 않는다. 손실 분석은 데이터 연결에서 가져온 파일과 실시간 현장 기록만 쓴다.
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

// 파일을 가져온 직후 보여 줄 점검 결과: 설비·날짜별 OEE와 "먼저 확인할 것"
function checkImport(days, defects, attached) {
  const items = days.map((d) => {
    const r = store.analyze({ from: d.date, to: d.date, machineId: d.machineId })[0];
    const m = MACHINES.find((x) => x.id === d.machineId);
    const unknown = r.stops.filter((s) => s.loss === 'unknown');
    const top = Object.entries(r.losses).sort((x, y) => y[1] - x[1])[0];
    const issues = [];
    if (unknown.length) issues.push({ level: 'action', text: `사유가 빈 정지 ${unknown.length}건 (합계 ${Math.round(unknown.reduce((a, s) => a + s.dur, 0) / 60)}분)`, todo: '정지 기록에서 사유 입력' });
    for (const w of r.warnings) issues.push({ level: 'review', text: w });
    return {
      machineId: d.machineId, machineName: m?.name ?? d.machineId, date: d.date,
      oee: r.oee, availability: r.availability, performance: r.performance, quality: r.quality,
      stops: r.stops.length, unknown: unknown.length, count: r.count, defectCount: r.defectCount,
      topLoss: top && top[1] > 0 ? { loss: top[0], label: LOSS[top[0]].label, sec: top[1] } : null,
      status: issues.some((i) => i.level === 'action') ? 'action' : issues.length ? 'review' : 'ok',
      issues,
    };
  });
  if (!days.length && defects.length) {
    const ok = attached > 0;
    return { kind: 'defects', status: ok ? 'ok' : 'review', defects: defects.length, attached,
      issues: ok ? [] : [{ level: 'review', text: '불량을 붙일 설비·날짜의 가동 기록이 없습니다.', todo: '같은 날짜의 가동 기록 파일을 먼저 올리기' }] };
  }
  const status = items.some((i) => i.status === 'action') ? 'action' : items.some((i) => i.status === 'review') ? 'review' : 'ok';
  return { kind: 'days', status, items };
}

// 파일 내용을 읽어 저장하고 점검 결과를 붙여 돌려준다 (내 파일 · 예시 파일 공통)
function importText(content, { format: fmt, filename } = {}) {
  const { format, days, defects } = parseFile(content, { format: fmt, filename });
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
  const rec = { at: new Date().toISOString(), file: filename ?? '(붙여넣기)', format, days: days.length, defects: attached };
  store.imports.push(rec);
  store.save();
  return {
    ...rec,
    imported: days.map((d) => ({ machineId: d.machineId, date: d.date, stops: d.stops.length, count: d.count })),
    check: checkImport(days, defects, attached),
  };
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
  'POST /api/import': (b) => importText(b.content ?? '', { format: b.format, filename: b.filename }),
  // 예시 파일 묶음을 서버에서 바로 가져온다 (2주치 전류 로그는 19MB라 브라우저로 주고받지 않는다)
  'POST /api/samples/import': (b) => {
    const f = SAMPLE_FILES.find((x) => x.key === b.key);
    if (!f) throw httpError(404, '알 수 없는 예시 파일입니다.');
    return importText(buildSampleText(b.range, b.key), { format: f.format, filename: sampleFileName(b.range, b.key) });
  },
  'GET /api/imports': () => store.imports.slice(-30).reverse(),
  'GET /api/samples': (_, q) => listSamples(q.range ?? '1d'),
  'POST /api/data/clear': () => {
    store.clear();
    live.reset();
    return { ok: true };
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
    const set = /^\/samples\/set\/(1d|1w|2w)\/([a-z]+)$/.exec(url.pathname);
    if (set) {
      const [, range, key] = set;
      const text = buildSampleText(range, key);
      if (url.searchParams.has('preview')) {
        // 미리보기: 앞부분 60줄과 전체 줄 수만 보낸다
        const lines = text.split('\n');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ head: lines.slice(0, 60).join('\n'), lines: lines.length }));
        return;
      }
      const name = sampleFileName(range, key);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
      res.end(text);
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
