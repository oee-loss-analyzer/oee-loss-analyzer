import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFile } from '../src/ingest/parsers.js';
import { SAMPLE_FILES, buildSampleText, sampleDates, listSamples } from '../src/sampleSets.js';

test('예시 묶음: 하루치·일주일치·2주일치 날짜 수', () => {
  assert.deepEqual(sampleDates('1d'), ['2026-11-13']);
  assert.equal(sampleDates('1w').length, 5);
  assert.equal(sampleDates('2w').length, 10);
  assert.equal(sampleDates('2w').at(-1), '2026-11-13');
});

test('예시 묶음: 일주일치 파일을 읽으면 설비마다 5일씩 나온다', () => {
  const dates = sampleDates('1w');
  for (const f of SAMPLE_FILES.filter((x) => x.format !== 'defects-json')) {
    const { days } = parseFile(buildSampleText('1w', f.key), { format: f.format });
    for (const m of f.machines) {
      const got = days.filter((d) => d.machineId === m.id).map((d) => d.date).sort();
      assert.deepEqual(got, dates, `${f.key} / ${m.id}`);
    }
  }
  const { defects } = parseFile(buildSampleText('1w', 'defects'), { format: 'defects-json' });
  assert.deepEqual([...new Set(defects.map((d) => d.date))].sort(), dates);
});

test('예시 묶음: "전부 가져오기" 파일끼리는 설비·날짜가 겹치지 않는다', () => {
  const seen = new Set();
  for (const f of SAMPLE_FILES.filter((x) => x.core && x.format !== 'defects-json')) {
    for (const m of f.machines) {
      assert.ok(!seen.has(m.id), `${m.id} 가 두 파일에 들어 있다`);
      seen.add(m.id);
    }
  }
});

test('예시 묶음: 하루치는 sample-data/ 의 파일과 내용이 같다', () => {
  const same = { ct: '01_press_ct-current_2026-11-13.csv', mes: '05_all_mes-daily-report_2026-11-13.csv' };
  for (const [key, file] of Object.entries(same)) {
    assert.equal(buildSampleText('1d', key), fs.readFileSync(new URL(`../sample-data/${file}`, import.meta.url), 'utf8'));
  }
  assert.equal(listSamples('1d').files.length, SAMPLE_FILES.length);
});
