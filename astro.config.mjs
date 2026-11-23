import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import expressiveCode from 'astro-expressive-code';
import { pluginLineNumbers } from '@expressive-code/plugin-line-numbers';
import { pluginCollapsibleSections } from '@expressive-code/plugin-collapsible-sections';
import remarkMath from 'remark-math';
import remarkEmoji from 'remark-emoji';
import remarkFlexibleMarkers from 'remark-flexible-markers';
import rehypeKatex from 'rehype-katex';
import rehypeCallouts from 'rehype-callouts';
import { remarkMermaid } from './src/plugins/remark-mermaid.mjs';
import { rehypeFigure } from './src/plugins/rehype-figure.mjs';

// SITE_URL / BASE_PATH 는 GitHub Actions 에서 GitHub Pages 설정값으로 자동 주입된다.
// (커스텀 도메인 연결 시에도 Pages 설정만 바꾸면 자동으로 따라간다)
export default defineConfig({
  site: process.env.SITE_URL || 'http://localhost:4321',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'ignore',
  integrations: [
    // expressiveCode 는 mdx 보다 먼저 등록해야 한다.
    expressiveCode({
      themes: ['github-light', 'github-dark'],
      useDarkModeMediaQuery: false,
      themeCssSelector: (theme) => (theme.type === 'dark' ? '.dark' : ':root:not(.dark)'),
      plugins: [pluginLineNumbers(), pluginCollapsibleSections()],
      defaultProps: {
        showLineNumbers: false,
        overridesByLang: {
          'bash,sh,shell,zsh,powershell,ps,cmd': { frame: 'terminal' },
        },
      },
      styleOverrides: {
        borderRadius: '8px',
        codeFontFamily: "'JetBrains Mono', 'D2Coding', Consolas, 'Pretendard Variable', monospace",
        codeFontSize: '0.875rem',
        uiFontFamily: 'inherit',
      },
    }),
    mdx(),
    sitemap(),
  ],
  markdown: {
    // remark/rehype 플러그인 생태계를 쓰기 위해 unified 프로세서 사용 (.mdx 도 이 설정을 그대로 따른다)
    processor: unified({
      remarkPlugins: [remarkMermaid, remarkMath, remarkEmoji, remarkFlexibleMarkers],
      rehypePlugins: [
        [rehypeKatex, { strict: false }],
        [rehypeCallouts, { theme: 'obsidian' }],
        rehypeFigure,
      ],
    }),
  },
});
