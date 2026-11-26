# Dev Notes

Astro 기반 정적 개발 블로그. 마크다운 파일만으로 글을 관리하고 GitHub Pages 에 무료로 배포한다. (DB·서버 없음)

## 기능

- **마크다운 확장**: GFM(표·체크리스트·각주·취소선·자동링크), 콜아웃(`> [!NOTE]`), 토글(`<details>`), 수식(KaTeX), Mermaid 다이어그램, `==형광펜==`, 이모지 단축코드, 이미지 캡션, HTML 직접 작성, MDX
- **코드 블록**: 문법 강조, 복사 버튼, 파일명 탭, 줄 강조, 추가/삭제 표시, 줄 번호, 접기, 터미널 프레임
- **카테고리**: `Backend/Spring/JPA` 처럼 원하는 깊이로 계층 분류 → 사이드바 트리, 카테고리별 페이지 자동 생성
- **태그**, **전체 검색**(Ctrl+K, Pagefind), **목차**(스크롤 위치 표시), **다크 모드**, 이전/다음 글, sitemap
- **draft / private**: `draft: true`(임시저장), `private: true`(비공개) 인 글은 로컬에서만 보이고 배포에서 제외

## 관리자 화면 (글쓰기)

배포된 블로그의 `/admin/` 에서 글을 쓰고, 수정하고, 삭제할 수 있다. 일반 방문자 화면에는 링크가 없고, 검색엔진 수집·사이트맵에서도 제외된다.

- 노션 스타일 에디터: `/` 슬래시 메뉴, 마크다운 단축 입력(`#`, `-`, `>`, ` ``` `, `1.`, `[]` 등), 블록 드래그, 선택 시 서식 툴바, 표·수식·코드블록(언어 선택)
- 슬래시 메뉴 `블로그` 그룹: 콜아웃(참고/팁/중요/경고/주의), 토글, Mermaid 다이어그램
- 이미지: 붙여넣기(Ctrl+V)·드래그·업로드 → 저장할 때 글과 같은 커밋으로 `images/<글파일명>/` 에 올라감
- 머리말 입력 폼: 제목, 카테고리(기존 카테고리 자동완성), 태그, 작성일, 파일 경로, 설명
- **임시저장**: 제목만 있어도 저장 가능(경로·카테고리는 발행할 때 정하면 됨). 새 글 화면 위의 "임시저장된 글" 목록에서 골라 이어 쓰기
- **비공개 저장**: 완성된 글을 블로그에 보이지 않게 저장(`private: true`). 임시저장 목록에는 나오지 않음. 발행된 글은 "비공개로 전환"으로 내릴 수 있음
- **발행**: 블로그에 공개. 비공개·발행에는 카테고리와 파일 경로가 필요
- `Ctrl+S`: 현재 상태(임시저장/비공개/발행) 그대로 저장. 저장 안 한 채로 나가면 경고, 다른 곳에서 먼저 수정된 글은 덮어쓰지 않고 알려줌
- 발행된 글을 수정하면 `updated`(수정일) 자동 기록

### 저장 기록은 작업 브랜치에, main 에는 커밋 하나로

관리자 화면의 저장·발행·삭제는 모두 작업 브랜치 `writing` 에 커밋된다(첫 로그인 때 main 에서 자동 생성). main 에는 아무것도 올라가지 않으므로 배포도 돌지 않는다.

목록 화면 위쪽에 **main 에 반영되지 않은 커밋 N개**와 그 목록이 표시되고, 커밋 메시지를 정한 뒤 **main 에 반영 (squash)** 을 누르면:

1. `writing` → main PR 을 만들어 **squash 병합** → main 에는 커밋 1개만 남는다 (본문에 세부 변경 목록 포함)
2. 그 push 로 GitHub Actions 배포가 **한 번** 돈다
3. `writing` 은 main 과 같은 지점으로 초기화된다. 저장 단위의 세부 커밋 기록은 병합된 PR 에 남는다

로컬에서 main 에 직접 push 한 변경은 관리자 화면에 로그인하거나 목록을 새로고침할 때 `writing` 으로 자동으로 가져온다.

### 동작 방식과 권한

DB·서버 없이 브라우저에서 GitHub API 로 리포지토리에 직접 커밋한다. 임시저장 글은 `draft: true`, 비공개 글은 `private: true` 인 글 파일로 저장되므로 다른 PC 에서도 이어 쓸 수 있고, 블로그 빌드에서는 제외된다.

로그인은 **이 블로그 리포지토리에만 쓰기 권한이 있는 GitHub 토큰**으로 한다. `/admin/` 페이지 자체는 누구나 열 수 있지만, 토큰이 없으면 아무것도 할 수 없다.

토큰 만들기:

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
2. Repository access: **Only select repositories** → 블로그 리포지토리 선택
3. Permissions → Repository permissions → **Contents: Read and write**, **Pull requests: Read and write**
4. 만료 기간은 원하는 만큼 (만료되면 새로 만들어 다시 로그인)

토큰은 해당 브라우저에만 저장된다(기본: 탭을 닫으면 삭제, "로그인 유지" 체크 시 계속 유지). 리포지토리와 배포 브랜치는 배포 빌드에서 자동으로 채워진다.

> 관리자 화면에서 main 에 반영하면 원격 main 에 커밋이 생기므로, 로컬에서도 작업한다면 시작 전에 `git pull` 을 먼저 한다.

## 로컬 실행

Node.js 22.23.4 이상 필요.

```bash
npm install
npm run dev        # http://localhost:4321 — 저장하면 바로 반영
```

검색은 빌드 결과물에서만 동작한다.

```bash
npm run build
npm run preview
```

## 글 쓰기 (파일로 직접)

관리자 화면 대신 로컬에서 마크다운 파일로 써도 된다.

```bash
npm run new -- spring/jpa-n-plus-1 "JPA N+1 문제" "Backend/Spring"
```

`src/content/posts/spring/jpa-n-plus-1.md` 가 생성된다. 자세한 작성법과 지원 문법은 블로그 안의 **「새 글 작성 방법」**, **「마크다운 문법 가이드」** 글 참고 (`src/content/posts/blog/`).

VS Code 에서 마크다운 파일에 이미지를 붙여넣으면(Ctrl+V) 글 옆 `images/` 폴더에 자동 저장된다.

## 블로그 정보 수정

`src/consts.ts` 에서 블로그 이름, 설명, GitHub 링크를 바꾼다.

## 배포 (GitHub Pages, 무료)

1. GitHub 에 새 저장소 생성
   - 저장소 이름을 `<GitHub아이디>.github.io` 로 만들면 주소가 `https://<아이디>.github.io` 가 된다. (권장)
   - 다른 이름(예: `dev-blog`)이면 `https://<아이디>.github.io/dev-blog` 가 된다. 이 경우에도 동작한다.
2. 코드 push

   ```bash
   git init
   git add .
   git commit -m "init blog"
   git branch -M main
   git remote add origin https://github.com/<아이디>/<저장소>.git
   git push -u origin main
   ```

3. 저장소 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 변경
4. **Actions** 탭에서 `Deploy to GitHub Pages` 워크플로우를 다시 실행(Re-run)하거나 아무 커밋이나 push

이후에는 `main` 에 push 할 때마다 자동 배포된다.

> 저장소는 Public 이어야 무료 플랜에서 Pages 를 쓸 수 있다.

## 커스텀 도메인 연결

1. 도메인 구매처 DNS 설정
   - 서브도메인(`blog.example.com`): `CNAME` 레코드 → `<아이디>.github.io`
   - 루트 도메인(`example.com`): `A` 레코드 4개 → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
2. 저장소 **Settings → Pages → Custom domain** 에 도메인 입력 후 저장, **Enforce HTTPS** 체크
3. Actions 에서 워크플로우 재실행

사이트 주소(`site`)와 경로(`base`)는 빌드할 때 Pages 설정에서 자동으로 가져오므로 코드 수정은 필요 없다.

## 폴더 구조

```text
src/
├─ content/posts/        글 (.md / .mdx)
├─ consts.ts             블로그 이름·설명
├─ layouts/              공통 레이아웃 (헤더, 사이드바)
├─ components/           카테고리 트리, 글 목록, 목차
├─ pages/                라우트 (글, 카테고리, 태그, 404, admin)
├─ admin/                관리자 화면 (GitHub API, 에디터, 머리말 처리)
├─ plugins/              mermaid / 이미지 캡션 플러그인
└─ styles/global.css     전체 스타일
scripts/new-post.mjs     새 글 생성 스크립트
.github/workflows/       GitHub Pages 배포
```
