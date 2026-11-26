import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    // "Backend/Spring" 처럼 / 로 하위 카테고리를 표현한다.
    category: z.string(),
    tags: z.array(z.string()).default([]),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    // true 면 로컬 dev 서버에서만 보이고 배포 빌드에서는 제외된다.
    draft: z.boolean().default(false), // 작성 중인 임시저장 글
    private: z.boolean().default(false), // 완성됐지만 공개하지 않는 비공개 글
  }),
});

export const collections = { posts };
