import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { LiveEngine } from '../src/live.js';
import { SHIFT, DETECTION } from '../src/config.js';

test('실시간 모드: 하루를 돌리면 2분 이상 정지마다 질문이 한 번씩만 간다', async () => {
  const store = new Store({ persist: false });
  const live = new LiveEngine(store);
  live.reset({ date: '2026-11-10' });
  live.autoAnswer = true;
  // 시연 기능: 09:00 에 3호기 금형 교체 12분 (조그 전류가 섞여도 질문은 1번)
  while (live.simSec < 9 * 3600) live.tick();
  live.inject('INJ-03', { code: 'SETUP', minutes: 12 });
  while (!live.ended) live.tick();
  await new Promise((r) => setTimeout(r, 10));

  for (const st of live.machines) {
    const day = store.getDay(st.machine.id, live.date);
    assert.equal(day.untilSec, SHIFT.end);
    const groups = [...new Set(day.stops.filter((s) => s.dur >= DETECTION.askReasonAfterSec).map((s) => s.group))];
    const qs = store.questions.filter((q) => q.machineId === st.machine.id);
    const qGroups = qs.map((q) => q.stopId);
    assert.equal(new Set(qGroups).size, qGroups.length, `${st.machine.id}: 같은 정지를 두 번 물음`);
    for (const g of groups) assert.ok(qGroups.includes(g), `${st.machine.id}: ${g} 정지에 질문이 없음`);
  }
  const inj = store.questions.filter((q) => q.machineId === 'INJ-03' && q.start >= 9 * 3600 && q.start <= 9 * 3600 + 60);
  assert.equal(inj.length, 1, '주입한 금형 교체 정지에 대한 질문은 정확히 1건');
  assert.ok(store.reasons.length > 0, '자동 응답이 기록되어야 함');
  live.pause();
});
