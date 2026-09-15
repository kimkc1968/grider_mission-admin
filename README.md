# GitHub Pages 배포 — 프로토타입 (레오엑스 미션 어드민)

아래 파일을 **폴더 구조 그대로** 올리면 됩니다. (상대경로로 CSS/JS를 불러오므로 구조가 바뀌면 깨집니다)

```
index.html                          ← 접속 시 미션 내역으로 이동
mission_add.html                    ← 미션 추가
mission_list.html                   ← 미션 내역 v2 (시작전·진행중·완료 / 미션별·참여자별·주문별)
mission_complete.html               ← v1 기록용 (선택)
public/assets/css/mission/mission_list.css
public/assets/css/mission/mission_add.css
public/assets/css/mission/mission_complete.css   (v1 선택)
public/assets/js/mission/mission_list.js
public/assets/js/mission/mission_add.js
public/assets/js/mission/mission_complete.js     (v1 선택)
```

- `nav_snippet.html`, `232131.txt`, `.claude/` 는 올릴 필요 없음
- 외부 라이브러리(jQuery, select2, sweetalert2, xeicon, SheetJS)는 CDN에서 로드 → 별도 파일 불필요
- `/common_assets/...`, `/public/...` 절대경로 링크는 실제 어드민용이며 Pages에서는 404가 나도 상대경로 fallback으로 정상 동작 (콘솔 404 경고는 무시)

## 배포
1. 새 저장소 생성 → 위 파일 업로드 (드래그&드롭 가능, 폴더 포함)
2. Settings → Pages → Build and deployment: **Deploy from a branch** → Branch `main` / `/ (root)` → Save
3. 1~2분 후 `https://<계정>.github.io/<저장소>/` 접속 → 자동으로 `mission_list.html` 로 이동

## 주의
- 목데이터로 동작하는 프로토타입입니다 (`CONFIG.USE_MOCK = true`). 실서버 연동 전까지는 저장/취소가 실제 반영되지 않습니다.
- 저장소를 Public 으로 두면 누구나 볼 수 있습니다. 내부 검토용이면 Private 저장소 + GitHub Pages(Private Pages는 Enterprise 플랜) 또는 링크 공유 범위를 확인하세요.

## 안 열릴 때 점검 (GitHub Pages)
1. **저장소 루트에 `.nojekyll` 파일이 있는지** — 없으면 Pages가 Jekyll로 빌드하면서 `nav_snippet.html`의 `{{ … }}` 문법 때문에 빌드가 실패합니다. 이 폴더의 `.nojekyll`(빈 파일)을 함께 올리거나, `nav_snippet.html`을 저장소에서 지우세요.
2. 저장소 **Actions 탭**에 `pages build and deployment`가 빨간색이면 1번 문제입니다. 초록색인데도 404면 3~4번.
3. 접속 주소는 `https://<계정>.github.io/<저장소>/` — 폴더를 하위 폴더로 올렸다면 `https://<계정>.github.io/<저장소>/<폴더명>/` (한글 폴더명이면 주소에 그대로 들어감).
4. Settings → Pages 에서 Source가 **Deploy from a branch / main / (root)** 인지, 저장소가 **Public**인지 확인 (Private 저장소는 유료 플랜에서만 Pages 가능).
5. 첫 배포는 1~3분 걸립니다. 반영 후에도 예전 화면이 보이면 강력 새로고침(Ctrl+F5).
6. 화면은 뜨는데 스타일이 깨지면 `public/assets/css/mission/*.css`, `public/assets/js/mission/*.js`가 **같은 폴더 구조로** 올라갔는지 확인 (파일명 대소문자 포함).
