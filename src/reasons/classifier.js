// 작업자 답변(자유 문장) → 정지 사유 코드
//  1) 규칙 기반 (키워드)  : 인터넷·API 키 없이 항상 동작
//  2) Claude (선택)       : ANTHROPIC_API_KEY 가 있으면 사용, 실패하면 규칙 기반으로 되돌아감

import { REASONS, reasonByCode } from '../config.js';

const RULES = {
  BREAKDOWN: [
    ['고장', 3], ['알람', 3], ['에러', 3], ['error', 3], ['탄 냄새', 3], ['타는', 2], ['누유', 3], ['유압', 2], ['모터', 2],
    ['베어링', 3], ['수리', 3], ['정비', 2], ['차단기', 3], ['히터', 2], ['이상한 소리', 3], ['소음', 2], ['과열', 3],
    ['파손', 3], ['부러', 3], ['안 돌아', 2], ['안 움직', 2], ['안 올라', 2], ['as ', 2], ['a/s', 2], ['비상정지', 3], ['e-', 2],
  ],
  SETUP: [
    ['금형', 2], ['교체', 2], ['바꿨', 2], ['바꾸', 2], ['갈았', 2], ['공구', 2], ['툴', 2], ['다이', 2], ['셋업', 3], ['세팅', 3],
    ['품번', 2], ['모델 변경', 3], ['지그', 2],
  ],
  ADJUST: [['조정', 3], ['시운전', 3], ['치수', 3], ['초품', 3], ['시사출', 3], ['보정', 3], ['조건', 2], ['맞추', 2], ['검사 받', 2]],
  MATERIAL: [['자재', 3], ['소재', 3], ['원료', 3], ['재료', 3], ['레진', 2], ['코일', 2], ['지게차', 3], ['입고', 2], ['떨어졌', 2], ['부족', 1], ['건조', 2]],
  OPERATOR: [['사람이 없', 3], ['작업자', 2], ['인원', 3], ['교육', 3], ['회의', 3], ['지원 갔', 3], ['화장실', 3], ['자리 비', 3]],
  JAM: [['걸려', 3], ['걸림', 3], ['끼었', 3], ['끼어', 3], ['낌', 2], ['막혀', 3], ['막힘', 3], ['뺐어', 2], ['빼느라', 2], ['엉켜', 3], ['슈트', 2], ['취출', 2], ['스크랩', 2]],
  CLEAN: [['청소', 3], ['칩', 2], ['정리', 2], ['점검', 2], ['주유', 3], ['그리스', 3], ['윤활', 3]],
};

// 동점일 때 우선순위 (고장 신호를 가장 중요하게 본다)
const PRIORITY = ['BREAKDOWN', 'JAM', 'SETUP', 'ADJUST', 'MATERIAL', 'OPERATOR', 'CLEAN'];

// 작업일보 사유 글의 [ ] 안은 위치·메모로 보고 분류에 쓰지 않는다 (예: "기계 고장 [건조기]" 의 '건조'가 자재 대기로 읽히지 않게)
export function stripNotes(text) {
  return String(text ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function classifyByRules(text, hint = '') {
  const t = ` ${stripNotes(text).toLowerCase()} `;
  const scores = {};
  const matched = {};
  for (const [code, words] of Object.entries(RULES)) {
    for (const [w, weight] of words) {
      if (t.includes(w)) {
        scores[code] = (scores[code] ?? 0) + weight;
        (matched[code] ??= []).push(w);
      }
    }
  }
  // "베어링 교체" 처럼 수리 맥락의 '교체'는 셋업이 아니라 고장
  if (scores.BREAKDOWN && scores.SETUP && /(베어링|모터|히터|부품).{0,6}(교체|갈)/.test(t)) delete scores.SETUP;
  // 설비가 보낸 힌트(알람, 수동 모드)도 약하게 반영
  const h = String(hint ?? '');
  if (/알람|alarm|fault/i.test(h)) scores.BREAKDOWN = (scores.BREAKDOWN ?? 0) + 1;
  if (/셋업|수동/.test(h)) scores.SETUP = (scores.SETUP ?? 0) + 1;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0]));
  if (!ranked.length) return { code: 'OTHER', confidence: 0.2, method: 'rule', matched: [] };
  const [code, score] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const confidence = Math.min(0.95, 0.5 + (score - second) * 0.12 + score * 0.04);
  return { code, confidence: Math.round(confidence * 100) / 100, method: 'rule', matched: matched[code] ?? [] };
}

// ---------- Claude (선택) ----------
let clientPromise = null;
export function llmEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.OEE_LLM !== 'off';
}

async function getClient() {
  clientPromise ??= import('@anthropic-ai/sdk')
    .then(({ default: Anthropic }) => new Anthropic())
    .catch((e) => {
      clientPromise = null;
      throw new Error(`@anthropic-ai/sdk 를 불러오지 못했습니다 (npm install 필요): ${e.message}`);
    });
  return clientPromise;
}

export const LLM_MODEL = process.env.OEE_LLM_MODEL || 'claude-opus-5-5';

const SYSTEM = `당신은 한국 중소 제조공장의 설비 정지 사유를 분류하는 도우미입니다.
작업자가 카카오톡으로 남긴 짧은 답변(사투리, 줄임말, 오타 포함)과 설비 신호 힌트를 보고, 정지 사유 코드 하나를 고릅니다.
코드:
${REASONS.map((r) => `- ${r.code}: ${r.label}`).join('\n')}
판단 기준: 설비 자체의 이상·수리는 BREAKDOWN, 품번·금형·공구를 바꾸는 계획된 작업은 SETUP, 바꾼 뒤 품질을 맞추는 작업은 ADJUST,
제품·자재가 끼거나 막혀 잠깐 멈춘 것은 JAM 입니다. 근거가 부족하면 OTHER 를 고르고 confidence 를 낮게 주세요.
summary 에는 공장장이 읽을 한 줄 요약(15자 이내, 한국어)을 씁니다.`;

const SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: REASONS.map((r) => r.code) },
    confidence: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['code', 'confidence', 'summary'],
  additionalProperties: false,
};

export async function classifyWithClaude(text, { hint, machineName } = {}) {
  const client = await getClient();
  const response = await client.beta.messages.create(
    {
      model: LLM_MODEL,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: `설비: ${machineName ?? '미상'}\n설비 신호 힌트: ${hint || '없음'}\n작업자 답변: "${text}"`,
      }],
    },
    { timeout: 20_000, maxRetries: 1 },
  );
  if (response.stop_reason === 'refusal') throw new Error('Claude가 응답을 거절했습니다');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Claude 응답에 텍스트가 없습니다');
  const parsed = JSON.parse(block.text);
  if (!reasonByCode(parsed.code)) throw new Error(`알 수 없는 코드: ${parsed.code}`);
  return { code: parsed.code, confidence: parsed.confidence, summary: parsed.summary, method: 'claude', model: response.model };
}

/** 사유 분류: Claude 가 켜져 있으면 먼저 시도하고, 안 되면 규칙 기반 */
export async function classifyReason(text, ctx = {}) {
  const rule = classifyByRules(text, ctx.hint);
  if (!llmEnabled() || ctx.noLlm) return rule;
  try {
    return await classifyWithClaude(text, ctx);
  } catch (e) {
    return { ...rule, method: 'rule', llmError: e.message };
  }
}

// ---------- 주간 리포트 문장 다듬기 (선택) ----------
export async function writeReportWithClaude(facts) {
  const client = await getClient();
  const response = await client.beta.messages.create(
    {
      model: LLM_MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: `당신은 중소 제조공장 공장장에게 매주 월요일 카카오톡으로 보내는 설비 손실 리포트를 씁니다.
주어진 분석 결과(JSON)의 숫자만 사용하고, 없는 숫자를 지어내지 마세요.
형식: 첫 줄에 공장 전체 OEE 와 전주 대비가 있으면 그 변화, 그다음 설비별로 "가장 큰 손실 → 원인 패턴 → 구체적인 제안" 순서.
문장은 짧게, 전문용어는 괄호로 풀어 주고, 전체 20줄 이내로 씁니다.`,
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    },
    { timeout: 60_000 },
  );
  if (response.stop_reason === 'refusal') throw new Error('Claude가 응답을 거절했습니다');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
