// 관리자 화면 미리보기: 블로그 빌드와 같은 순서·같은 플러그인으로 마크다운을 HTML 로 변환한다.
// 순서는 @astrojs/markdown-remark 의 unified 프로세서와 동일:
// parse → gfm → smartypants → 블로그 remark 플러그인 → remark-rehype → 블로그 rehype 플러그인 → Expressive Code → rehype-raw
import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkSmartypants from 'remark-smartypants';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import rehypeExpressiveCode from 'rehype-expressive-code';
import { expressiveCodeOptions, remarkPlugins, rehypePlugins } from '../markdown/options.mjs';

let processor: Processor<any, any, any, any, string> | null = null;

function createProcessor() {
  const pipeline = unified().use(remarkParse).use(remarkGfm).use(remarkSmartypants);
  for (const plugin of remarkPlugins) pipeline.use(plugin as any);
  pipeline.use(remarkRehype, { allowDangerousHtml: true });
  for (const entry of rehypePlugins) {
    if (Array.isArray(entry)) pipeline.use(entry[0] as any, entry[1]);
    else pipeline.use(entry as any);
  }
  return pipeline
    .use(rehypeExpressiveCode, expressiveCodeOptions as any)
    .use(rehypeRaw)
    .use(rehypeStringify, { allowDangerousHtml: true }) as unknown as Processor<any, any, any, any, string>;
}

export async function renderMarkdown(markdown: string): Promise<string> {
  processor ??= createProcessor();
  return String(await processor.process(markdown));
}

/** 블로그 글 페이지의 후처리와 동일: Mermaid 다이어그램 렌더링, 넓은 표 가로 스크롤 */
export async function enhancePreview(container: HTMLElement): Promise<void> {
  container.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('table-wrapper')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  });

  const blocks = [...container.querySelectorAll<HTMLElement>('pre.mermaid')];
  if (blocks.length === 0) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
    securityLevel: 'strict',
  });
  await mermaid.run({ nodes: blocks });
}
