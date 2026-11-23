// 사용법: npm run new -- <파일경로> "<제목>" "<카테고리>"
// 예시:   npm run new -- spring/jpa-n-plus-1 "JPA N+1 문제" "Backend/Spring"
//   → src/content/posts/spring/jpa-n-plus-1.md 생성 (URL: /posts/spring/jpa-n-plus-1/)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [filePath, title, category] = process.argv.slice(2);

if (!filePath || !title || !category) {
  console.error('사용법: npm run new -- <파일경로> "<제목>" "<카테고리>"');
  console.error('예시:   npm run new -- spring/jpa-n-plus-1 "JPA N+1 문제" "Backend/Spring"');
  process.exit(1);
}

const target = join('src/content/posts', filePath.replace(/\.mdx?$/, '') + (filePath.endsWith('.mdx') ? '.mdx' : '.md'));

if (existsSync(target)) {
  console.error(`이미 존재하는 파일입니다: ${target}`);
  process.exit(1);
}

const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19);

const frontmatter = `---
title: ${JSON.stringify(title)}
description: ""
category: ${JSON.stringify(category)}
tags: []
date: ${kst}+09:00
draft: true
---

`;

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, frontmatter);
console.log(`생성됨: ${target}`);
console.log('작성이 끝나면 draft: true 를 false 로 바꾸거나 지우면 배포됩니다.');
