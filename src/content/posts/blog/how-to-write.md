---
title: "새 글 작성 방법"
description: "글 파일 만들기, 카테고리·태그 지정, 이미지 넣기, 배포까지"
category: "Blog"
tags: [ 블로그 ]
date: 2026-11-23T15:00:00+09:00
private: true
---

## 관리자 화면에서 쓰기

블로그 주소 뒤에 `/admin/` 을 붙여 들어가면 노션처럼 글을 쓸 수 있습니다. (예: `https://아이디.github.io/blog/admin/`)

- 빈 줄에서 `/` 를 입력하면 블록 메뉴가 열립니다. **블로그** 그룹에 콜아웃, 토글, Mermaid 가 있습니다.
- `## ` `- ` `1. ` `> ` ` ``` ` `[] ` 처럼 마크다운을 입력하면 바로 해당 블록으로 바뀝니다.
- 이미지는 붙여넣기(Ctrl+V)나 드래그로 넣습니다.
- 쓰는 도중에는 **임시저장**(`Ctrl+S`)합니다. 제목만 있으면 되고, 새 글 화면 위의 "임시저장된 글" 목록에서 골라 이어 쓸 수 있습니다.
- 다 쓰면 카테고리와 **글 이름**(영문)을 정하고 **발행**합니다. 주소는 자동으로 정해집니다. (카테고리 `Backend/Spring` + 글 이름 `jpa-n-plus-1` → `/posts/backend/spring/jpa-n-plus-1/`) 블로그에 공개하지 않으려면 **비공개 저장**합니다. 비공개 글은 임시저장 목록에 나오지 않습니다.
- 저장·발행은 작업 브랜치(`writing`)에만 기록되고 블로그에는 반영되지 않습니다. 목록 화면의 **main 에 반영**을 누르면 그동안의 기록이 main 에 커밋 하나로 합쳐져 한 번에 배포됩니다.

> [!NOTE]
> 처음 한 번은 GitHub 토큰으로 로그인해야 합니다. 토큰 만드는 방법은 로그인 화면의 "토큰 만드는 방법" 을 참고하세요.

아래는 에디터 대신 파일로 직접 쓰는 방법입니다.

## 1. 글 파일 만들기

`src/content/posts/` 아래에 `.md` 파일을 만들면 그게 곧 글입니다. 폴더는 자유롭게 나눠도 되고, **파일 경로가 그대로 URL** 이 됩니다.

```text
src/content/posts/spring/jpa-n-plus-1.md  →  /posts/spring/jpa-n-plus-1/
```

> [!TIP]
> URL 이 깔끔하도록 파일명은 영문 소문자와 `-` 로 짓는 것을 권장합니다.

명령어로 만들면 머리말(frontmatter)까지 채워진 파일이 생성됩니다.

```bash
npm run new -- spring/jpa-n-plus-1 "JPA N+1 문제" "Backend/Spring"
```

## 2. 머리말 (frontmatter)

파일 맨 위 `---` 사이에 글 정보를 적습니다.

```yaml
---
title: "JPA N+1 문제"          # 필수
description: "원인과 해결 방법"   # 선택 — 목록과 검색 결과에 표시
category: "Backend/Spring"     # 필수 — / 로 하위 카테고리
tags: ["JPA", "성능"]           # 선택
date: 2026-11-23T10:00:00+09:00 # 필수 — 작성일
updated: 2026-11-30             # 선택 — 수정일
draft: true                     # 선택 — true 면 임시저장 글(배포되지 않음)
private: true                   # 선택 — true 면 비공개 글(배포되지 않음)
---
```

| 항목            |  필수 | 설명                                             |
| ------------- | :-: | ---------------------------------------------- |
| `title`       |  O  | 글 제목                                           |
| `category`    |  O  | `Backend/Spring/JPA` 처럼 `/` 로 원하는 깊이만큼 나눌 수 있음 |
| `date`        |  O  | 정렬 기준                                          |
| `description` |     | 요약                                             |
| `tags`        |     | 카테고리와 별개로 가로질러 묶을 때 사용                         |
| `updated`     |     | 수정일 표시                                         |
| `draft`       |     | `true` 면 `npm run dev` 에서만 보이고 배포 빌드에서 빠짐      |

카테고리는 따로 등록할 필요 없이 글에 적는 순간 사이드바와 카테고리 페이지에 생깁니다.

## 3. 이미지 넣기

VS Code 에서 마크다운 파일을 열고 이미지를 **붙여넣기(Ctrl+V)** 하거나 **드래그**하면 `images/<글파일명>/` 폴더에 저장되고 링크가 자동으로 들어갑니다. (`.vscode/settings.json` 에 설정되어 있음)

```md
![설명](./images/jpa-n-plus-1/image.png)
```

## 4. 미리보기

```bash
npm run dev
```

브라우저에서 `http://localhost:4321` 을 열면 저장할 때마다 바로 반영됩니다. 검색은 빌드 결과물에서만 동작하므로 확인하려면 아래를 실행합니다.

```bash
npm run build
npm run preview
```

## 5. 배포

```bash
git add .
git commit -m "post: JPA N+1 문제"
git push
```

`main` 브랜치에 push 하면 GitHub Actions 가 빌드해서 1\~2분 안에 사이트에 반영됩니다.

## MDX

`.mdx` 확장자로 만들면 글 안에서 Astro 컴포넌트를 import 해서 쓸 수 있습니다. 단, MDX 에서는 HTML 을 JSX 문법으로 써야 하므로(`class` → `className`, `<br>` → `<br />`) 평소에는 `.md` 를 쓰는 것을 권장합니다.
