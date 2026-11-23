# Dev Notes

Astro 기반 정적 개발 블로그. 마크다운 파일만으로 글을 관리하고 GitHub Pages 에 무료로 배포한다. (DB·서버 없음)

## 기능

- **마크다운 확장**: GFM(표·체크리스트·각주·취소선·자동링크), 콜아웃(`> [!NOTE]`), 토글(`<details>`), 수식(KaTeX), Mermaid 다이어그램, `==형광펜==`, 이모지 단축코드, 이미지 캡션, HTML 직접 작성, MDX
- **코드 블록**: 문법 강조, 복사 버튼, 파일명 탭, 줄 강조, 추가/삭제 표시, 줄 번호, 접기, 터미널 프레임
- **카테고리**: `Backend/Spring/JPA` 처럼 원하는 깊이로 계층 분류 → 사이드바 트리, 카테고리별 페이지 자동 생성
- **태그**, **전체 검색**(Ctrl+K, Pagefind), **목차**(스크롤 위치 표시), **다크 모드**, 이전/다음 글, sitemap
- **draft**: `draft: true` 인 글은 로컬에서만 보이고 배포에서 제외

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

## 글 쓰기

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
├─ pages/                라우트 (글, 카테고리, 태그, 404)
├─ plugins/              mermaid / 이미지 캡션 플러그인
└─ styles/global.css     전체 스타일
scripts/new-post.mjs     새 글 생성 스크립트
.github/workflows/       GitHub Pages 배포
```
