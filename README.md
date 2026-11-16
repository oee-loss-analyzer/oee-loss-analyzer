# 멈춘 이유까지 알려 주는 OEE 손실 분석 서비스

경북 해커톤 아이디어 2번(「OEE 손실 분석 서비스 기획서」 최종본)을 동작하는 프로토타입으로 만든 것입니다.

> 기계가 멈추면 이유를 묻고, 그 답을 모아서 "이번 주에 어디서, 왜, 얼마를 잃었는지" 알려 준다.

## 실행

Node.js 20 이상만 있으면 됩니다. 다른 패키지는 설치하지 않아도 됩니다.

```bash
npm start
```

브라우저에서 http://localhost:4300 을 엽니다. 처음에는 손실 분석이 비어 있습니다. **데이터 연결** 탭에서 예시 파일(하루치 · 일주일치, 2026-11-13까지)을 가져오면 손실 분석과 주간 리포트에서 볼 수 있습니다. 예시 묶음은 `src/sampleSets.js`가 요청할 때 만들고, 하루치는 `sample-data/`의 파일과 같습니다.

```bash
npm test         # 엔진 테스트 (형식 변환 왕복, OEE 공식, 기획서 예시, 실시간 질문)
npm run samples  # 샘플 파일 다시 만들기
```

### Claude로 사유 분류하기 (선택)

API 키가 없으면 키워드 규칙으로 분류합니다. 키를 넣으면 작업자의 자유로운 답변("유압이 안 올라와서 세웠슈")을 Claude가 분류하고, 주간 리포트 문장도 다듬어 줍니다. Claude 호출이 실패하면 자동으로 규칙 기반으로 돌아갑니다.

```bash
npm install                      # @anthropic-ai/sdk 설치
set ANTHROPIC_API_KEY=sk-ant-... # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

- 기본 모델은 `claude-opus-5-5`이고, 바꾸려면 `OEE_LLM_MODEL` 환경 변수를 설정합니다. 키가 있어도 `OEE_LLM=off`로 끌 수 있습니다.
- 서버 쪽 거절 대비(`fallbacks: "default"`)를 켜 두었습니다.
- 실시간 모드의 "작업자 자동 응답"과 데모 데이터는 비용이 들지 않도록 규칙 기반만 씁니다.

## 화면

| 탭 | 하는 일 |
|---|---|
| **실시간 현장** | 오늘 하루를 빨리 감기로 돌립니다(기본 1초 = 1분). 설비 3대의 전류, 가동 상태, 생산 수량, 오늘의 OEE와 손실이 실시간으로 바뀝니다. 설비가 **2분 넘게 멈추면 카톡 모양의 질문 창**이 뜨고, 버튼을 누르거나 글·음성(🎤, Chrome/Edge)으로 답하면 사유가 분류됩니다. 시연할 때는 "지금 멈추기" 버튼으로 원하는 정지를 일으킬 수 있습니다. |
| **손실 분석** | OEE, 시간가동률, 성능가동률, 양품률, 손실 순위(시간·금액), 발견 사항(속도 저하 시간대, 반복되는 걸림, 셋업 편차, MTTR/MTBF, 응답률), 시간대별 손실 히트맵, 날짜별 추세, 정지 기록을 보여 줍니다. 사유가 빈 정지는 여기서 나중에 입력할 수 있습니다. |
| **주간 리포트** | 공장장에게 매주 보내는 문장형 리포트입니다. 전 기간 대비 변화가 들어가고, Claude로 다듬기를 할 수 있습니다. |
| **데이터 연결** | 아래 5가지 산업 데이터 형식의 파일을 올리면 같은 방식으로 분석합니다. 샘플 파일 다운로드와 실제 데이터 사이트 목록도 있습니다. |

### 30초 시연 순서

1. 실시간 현장에서 **▶ 시작**을 누릅니다.
2. 3호기 사출기의 **금형·공구 교체 12분 → 지금 멈추기**를 누릅니다.
3. 2분(실제 2초) 뒤 질문 창이 뜨면 🎤를 누르고 "금형 바꿨어요"라고 말합니다.
4. "오늘의 손실"에 셋업·조정이 쌓이는지 봅니다.
5. 손실 분석 탭과 주간 리포트 탭으로 넘어갑니다.

## 데이터 형식: "데이터는 어디서든, 분석은 우리가"

가상 공장 시뮬레이터(`src/sim/factory.js`)가 설비의 하루를 만들고(정지와 사유, 사이클, 순간정지, 오후 속도 저하, 셋업 직후 불량), `src/sim/formats.js`가 그 하루를 현장에서 실제로 쓰는 형식으로 내보냅니다. `src/ingest/parsers.js`는 그 형식을 다시 읽어 같은 표준 형태(DayRecord)로 바꿉니다. 테스트에서는 내보낸 데이터를 다시 읽었을 때 정답과 맞는지 확인합니다.

| 형식 | 흉내 낸 현장 장비 | 파일 예 |
|---|---|---|
| 전류 센서 CSV | 시판 CT 전력·전류 측정기, 1초 로그 (전류·전압·전력·역률) | `01_press_ct-current_*.csv` |
| MTConnect Streams XML | CNC의 MTConnect Agent `/sample` 응답 (Execution, ControllerMode, PartCount, Fault) | `02_cnc_mtconnect-sample_*.xml` |
| OPC UA PubSub JSON Lines | 사출기 게이트웨이의 OPC UA JSON 메시지 (EUROMAP 77을 단순화한 MachineState, ShotCounter) | `03_injection_opcua-pubsub_*.jsonl` |
| Modbus 폴링 로그 CSV | Modbus TCP 게이트웨이가 5초마다 읽은 레지스터 (40001 운전 상태, 40002~3 카운터, 40010 알람) | `04_press_modbus-poll_*.csv` |
| MES/POP 작업일보 CSV | 정부 지원으로 깔아 둔 MES의 엑셀 내보내기. 짧은 정지 누락, 5분 단위 반올림, 사유 빈칸처럼 수기 입력의 문제를 일부러 넣었습니다 | `05_all_mes-daily-report_*.csv` |
| 작업자 불량 입력 JSON | 카톡 [불량 +1] 버튼 기록 | `06_all_operator-defects_*.json` |

`99_ground-truth_*.json`은 시뮬레이션 정답입니다. 분석 결과와 비교할 때 쓰고, 업로드용은 아닙니다.

실제 장비 형식과 다른 점: 필드 이름과 구조는 각 표준을 따랐지만 **단순화한 가상 데이터**입니다. 실제 장비에 붙일 때는 설비 ID 매핑, 레지스터 주소, OPC UA 노드 ID를 현장에 맞게 바꿔야 합니다. 설비 정보는 `src/config.js` 한 곳에서 관리합니다.

## 계산 방식 (`src/core/oee.js`)

```
계획 시간  = 근무 시간 − 계획정지(점심)
가용 손실  = 고장 · 셋업·조정 · 대기 · 점검·기타 · 사유 미입력(5분 이상)
성능 손실  = 가동 시간 − 생산수량 × 이론 사이클   → 순간정지(사유가 걸림이거나 5분 미만) + 속도 저하(1분 미만 정지 포함)
품질 손실  = 불량 × 이론 사이클                 → 초기 수율(근무·점심·셋업·고장 직후 15분) + 공정 불량
OEE       = 양품 × 이론 사이클 ÷ 계획 시간 = 시간가동률 × 성능가동률 × 양품률
손실 금액  = 손실 시간 ÷ 이론 사이클 × 제품 1개 이익
```

- 전류로 상태를 판정합니다. 가동 전류의 55% 이상이면 가동이고, 사이클 피크로 수량을 셉니다.
- 1분 미만의 정지는 정지로 치지 않고 속도 저하에 포함합니다.
- 셋업 중 잠깐 돌린 시운전(조그)은 정지 하나로 합칩니다.
- 이 기준값은 모두 `config.js`의 `DETECTION`에 있습니다.

## 폴더 구조

```
server.js                HTTP 서버 + API (외부 패키지 없음)
src/config.js            설비·근무·판정 기준·손실 분류·사유 버튼
src/sim/                 가상 공장 시뮬레이터, 산업 데이터 형식 내보내기
src/ingest/parsers.js    형식 자동 인식 + 읽기
src/core/                표준 형태 변환, OEE·손실 계산, 패턴 찾기·리포트
src/reasons/classifier.js 사유 분류 (규칙 + Claude 선택)
src/live.js              실시간 모드 (빨리 감기, 질문 만들기)
src/demo.js              작업자 답변 흉내 · 평일 날짜 계산
src/sampleSets.js        예시 파일 묶음 (하루치·일주일치)
public/                  화면 (HTML/CSS/JS)
test/                    node:test 테스트
```

## 실제 산업 데이터를 구할 수 있는 곳

| 사이트 | 내용 |
|---|---|
| [KAMP 인공지능 제조 플랫폼](https://www.kamp-ai.kr/aidataList) | 중기부 운영. CNC 머신, 사출성형기, 프레스기, 용접기 등 제조 AI 데이터셋 50종 무료 (회원가입 필요). 국내 중소 공장 실데이터에 가장 가까움 |
| [KAMP 제조데이터 라이브러리](https://mdata.kamp-ai.kr/) | 업종별(사출, 주조, 정밀가공 등) 제조 데이터 상품 |
| [공공데이터포털 · 제조AI 데이터셋 50종](https://www.data.go.kr/data/15089213/fileData.do) | KAMP 데이터셋 50종의 업종, 목적, 다운로드 링크를 CSV 하나로 정리 (로그인 없이 다운로드) |
| [AI Hub · 기계시설물 고장 예지 센서](https://aihub.or.kr/aihubdata/data/view.do?aihubDataSe=&currMenu=115&dataSetSn=238&topMenu=100) | 전동기 진동·전류 233만 건 (정상, 베어링 불량, 불평형, 축정렬 불량, 벨트 느슨함). 내국인 신청 필요 |
| [AI Hub · SMT 공정 개선 멀티모달](https://aihub.or.kr/aihubdata/data/view.do?aihubDataSe=data&currMenu=115&dataSetSn=71900&topMenu=100) | 전자부품 SMT 공정 센서 + 검사 이미지 (구미 전자 업종과 맞음) |
| [MTConnect 공식](https://www.mtconnect.org/) | `docker run -p 5000:5000 mtconnect/agent` 로 CNC 데모 데이터를 실시간으로 받아 볼 수 있음. 이 서비스의 MTConnect 가져오기와 같은 XML 형식 |
| [UCI MetroPT-3](https://archive.ics.uci.edu/dataset/791/metropt+3+dataset) | 실제 압축기의 모터 전류·압력 1초 데이터 + 고장 기록. 전류로 가동을 판정하는 연습용 |
| [UCI AI4I 2020](https://archive.ics.uci.edu/dataset/601/ai4i+2020+predictive+maintenance+dataset) | 고장 유형 라벨이 있는 예지보전 합성 데이터 |
| [CWRU 베어링 데이터 센터](https://engineering.case.edu/bearingdatacenter) | 진동 기반 고장 진단(3단계 기능)의 표준 벤치마크 |

이 데이터들은 대부분 예지보전이나 품질 연구용이라 **정지 사유가 들어 있지 않습니다.** 그 빈칸을 채우는 것이 이 서비스의 차별점입니다. 실데이터를 쓰려면 `src/ingest/parsers.js`에 해당 컬럼을 읽는 함수를 추가하면 됩니다(전류 컬럼이 있으면 `currentToEvents`를 그대로 쓸 수 있습니다).

## 한계 (프로토타입)

- 저장소는 `data/db.json` 파일입니다. 실제 서비스에서는 DB로 바꿔야 합니다.
- 카카오 알림톡 대신 웹 화면의 질문 창을 씁니다.
- 로그인과 공장별 분리가 없습니다.
- 손실 금액은 "잃은 시간에 만들 수 있었던 제품 × 1개당 이익"으로 낸 추정치입니다.
