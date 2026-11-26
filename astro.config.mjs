import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import expressiveCode from 'astro-expressive-code';
import { expressiveCodeOptions, remarkPlugins, rehypePlugins } from './src/markdown/options.mjs';

// SITE_URL / BASE_PATH 는 GitHub Actions 에서 GitHub Pages 설정값으로 자동 주입된다.
// (커스텀 도메인 연결 시에도 Pages 설정만 바꾸면 자동으로 따라간다)
export default defineConfig({
  site: process.env.SITE_URL || 'http://localhost:4321',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'ignore',
  integrations: [
    // expressiveCode 는 mdx 보다 먼저 등록해야 한다.
    expressiveCode(expressiveCodeOptions),
    mdx(),
    sitemap({ filter: (page) => !page.includes('/admin') }),
  ],
  markdown: {
    // remark/rehype 플러그인 생태계를 쓰기 위해 unified 프로세서 사용 (.mdx 도 이 설정을 그대로 따른다)
    // 플러그인 설정은 관리자 미리보기와 공유한다 → src/markdown/options.mjs
    processor: unified({ remarkPlugins, rehypePlugins }),
  },
});
