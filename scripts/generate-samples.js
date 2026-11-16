// 산업 데이터 형식 샘플 파일 만들기:  npm run samples
// 만들어진 파일은 화면의 "데이터 연결" 탭에서 그대로 올려 볼 수 있다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_MACHINES as MACHINES } from '../src/config.js';
import { simulateDay } from '../src/sim/factory.js';
import { FORMATS, encodeDefectLog } from '../src/sim/formats.js';

export const SAMPLE_DATE = '2026-11-13';

export function generateSamples(dir, date = SAMPLE_DATE) {
  fs.mkdirSync(dir, { recursive: true });
  const [press, cnc, inj] = MACHINES;
  const truths = Object.fromEntries(MACHINES.map((m) => [m.id, simulateDay(m, date, { seed: `sample|${m.id}|${date}` })]));
  const files = [
    { name: `01_press_ct-current_${date}.csv`, fmt: 'ct-csv', m: press, desc: '1호기 프레스 · 시판 전류 센서(CT) 1초 로그' },
    { name: `02_cnc_mtconnect-sample_${date}.xml`, fmt: 'mtconnect', m: cnc, desc: '2호기 CNC · MTConnect Agent /sample 응답' },
    { name: `03_injection_opcua-pubsub_${date}.jsonl`, fmt: 'opcua', m: inj, desc: '3호기 사출기 · OPC UA PubSub JSON 메시지' },
    { name: `04_press_modbus-poll_${date}.csv`, fmt: 'modbus-csv', m: press, desc: '1호기 프레스 · Modbus TCP 게이트웨이 5초 폴링 로그' },
  ];
  const out = [];
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f.name), FORMATS[f.fmt].encode(f.m, truths[f.m.id]));
    out.push({ file: f.name, format: f.fmt, description: f.desc });
  }
  // MES 작업일보: 세 설비를 한 파일로
  const mes = MACHINES.map((m, i) => {
    const csv = FORMATS['mes-csv'].encode(m, truths[m.id]);
    return i === 0 ? csv : csv.split('\n').slice(1).join('\n');
  }).join('');
  const mesName = `05_all_mes-daily-report_${date}.csv`;
  fs.writeFileSync(path.join(dir, mesName), mes);
  out.push({ file: mesName, format: 'mes-csv', description: '설비 3대 · MES/POP 작업일보 (수기 입력 누락 포함)' });
  const defName = `06_all_operator-defects_${date}.json`;
  fs.writeFileSync(path.join(dir, defName), JSON.stringify(MACHINES.flatMap((m) => encodeDefectLog(m, truths[m.id])), null, 1));
  out.push({ file: defName, format: 'defects-json', description: '작업자 카톡 [불량 +1] 입력 기록 (위 파일들과 같은 날짜)' });
  // 정답지: 테스트·검증용
  const truthName = `99_ground-truth_${date}.json`;
  fs.writeFileSync(path.join(dir, truthName), JSON.stringify(Object.fromEntries(MACHINES.map((m) => [m.id, {
    stops: truths[m.id].stops, cycles: truths[m.id].cycles.length, defects: truths[m.id].defects.length,
  }])), null, 1));
  out.push({ file: truthName, format: 'truth', description: '시뮬레이션 정답 (분석 결과와 비교용, 업로드용 아님)' });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ date, files: out }, null, 1));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve('sample-data');
  const files = generateSamples(dir);
  for (const f of files) console.log(`  ${f.file}  —  ${f.description}`);
  console.log(`\n${files.length}개 파일을 ${dir} 에 만들었습니다.`);
}
