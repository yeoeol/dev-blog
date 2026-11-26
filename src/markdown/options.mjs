// 블로그 빌드(astro.config.mjs)와 관리자 화면 미리보기가 같은 마크다운 설정을 쓰도록 한 곳에 모아 둔다.
import { pluginLineNumbers } from '@expressive-code/plugin-line-numbers';
import { pluginCollapsibleSections } from '@expressive-code/plugin-collapsible-sections';
import remarkMath from 'remark-math';
import remarkEmoji from 'remark-emoji';
import remarkFlexibleMarkers from 'remark-flexible-markers';
import rehypeKatex from 'rehype-katex';
import rehypeCallouts from 'rehype-callouts';
import { remarkMermaid } from '../plugins/remark-mermaid.mjs';
import { rehypeFigure } from '../plugins/rehype-figure.mjs';

/** 코드 블록 (Expressive Code) */
export const expressiveCodeOptions = {
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
};

export const remarkPlugins = [remarkMermaid, remarkMath, remarkEmoji, remarkFlexibleMarkers];

export const rehypePlugins = [
  [rehypeKatex, { strict: false }],
  [
    rehypeCallouts,
    {
      theme: 'obsidian',
      // 관리자 에디터의 '토글' 블록: > [!toggle]- 제목
      callouts: { toggle: { title: '토글', indicator: '' } },
    },
  ],
  rehypeFigure,
];
