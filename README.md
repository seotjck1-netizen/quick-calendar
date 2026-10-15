# 빠른 일정 등록

문장을 입력하면 Claude(Haiku 5.5)가 해석해서 구글 캘린더에 일정을 넣는 앱입니다.

- **PWA**: 아이폰 홈 화면에 설치해 쓰는 웹앱. 여러 일정 한번에, 반복 일정, 등록 전 확인/수정.
- **아이폰 단축어**: "시리야, 일정 등록"으로 음성 등록 → [SHORTCUT.md](SHORTCUT.md)

```
입력 ─▶ Claude API (request-template.json의 프롬프트+스키마) ─▶ 확인 화면 ─▶ Google Calendar API
```

서버가 없습니다. API 키와 구글 토큰은 사용하는 기기의 브라우저에만 저장됩니다.

## 파일

| 파일 | 역할 |
|---|---|
| `request-template.json` | Claude 요청 본문(프롬프트, JSON 스키마). PWA와 단축어가 함께 씀 |
| `parse.js` | Claude 호출, 날짜표 생성, 결과 정리 |
| `gcal.js` | 구글 로그인(리디렉션 방식), 캘린더 일정 생성 |
| `app.js` | 화면 동작 |
| `sw.js`, `manifest.webmanifest`, `icons/` | 홈 화면 설치, 빠른 실행 |
| `serve.ps1` | PC에서 테스트용 로컬 서버 |

## 설정 순서

### 1. Claude API 키
[console.anthropic.com](https://console.anthropic.com) → API Keys → 키 생성. 사용량 한도(월 $5 등)를 걸어 두면 안전합니다.

### 2. Google OAuth 클라이언트 ID (약 10분)
1. [console.cloud.google.com](https://console.cloud.google.com) → 새 프로젝트 생성
2. **API 및 서비스 → 라이브러리** → "Google Calendar API" 사용 설정
3. **OAuth 동의 화면** → 외부(External) → 앱 이름, 이메일 입력 → 범위는 비워둬도 됨 → **테스트 사용자에 내 Gmail 추가**
   (게시 상태를 "테스트"로 두면 심사가 필요 없습니다)
4. **사용자 인증 정보 → OAuth 클라이언트 ID 만들기** → 유형 "웹 애플리케이션"
   - 승인된 JavaScript 원본: `http://localhost:8080`, `https://<배포 주소 도메인>`
   - 승인된 리디렉션 URI: `http://localhost:8080/`, `https://<배포 주소>/` (앱 설정 화면에 표시되는 값과 **정확히** 같아야 함)
5. 생성된 클라이언트 ID 복사

### 3. PC에서 테스트
```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```
브라우저에서 `http://localhost:8080` → ⚙︎ 설정에 API 키와 클라이언트 ID 입력.

### 4. 배포 (아이폰에서 쓰려면 HTTPS 필요)
GitHub Pages가 가장 간단합니다: 이 폴더를 GitHub 저장소에 올리고 Settings → Pages → 브랜치 선택.
주소(예: `https://아이디.github.io/quick-calendar/`)를 2-4단계의 원본/리디렉션 URI에 추가하세요.

### 5. 아이폰에 설치
Safari로 배포 주소 접속 → 공유 → **홈 화면에 추가** → 앱 아이콘으로 실행 → ⚙︎에서 키 입력.
(홈 화면 앱은 Safari와 저장소가 분리되어 있어 키를 앱 안에서 한 번 더 입력해야 합니다.)

## 참고

- 구글 로그인은 1시간마다 만료됩니다. 만료되면 "추가" 시 자동으로 로그인 화면을 거쳐 돌아와서 이어서 등록합니다.
- 비용: Haiku 5.5 기준 일정 해석 1회당 1원 미만입니다.
- 앱 파일을 수정한 뒤에는 `sw.js`의 `CACHE` 버전을 올려야 기기에 반영됩니다.
