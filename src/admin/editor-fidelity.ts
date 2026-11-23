// 블로그 마크다운을 에디터에서 열었다가 저장해도 손실이 없도록 Milkdown 기본 동작을 보정한다.
import type { Editor } from '@milkdown/kit/core';
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';

// 코드블록 meta (title="..." {3} ins={2} showLineNumbers 등) 보존.
// Crepe 의 Latex 기능이 code_block 스키마를 한 번 확장해서 등록하므로, 같은 방식으로 확장한 스키마를 마지막에 등록해 덮어쓴다.
const codeBlockWithMeta = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, meta: { default: '', validate: 'string' } },
    parseMarkdown: {
      match: ({ type }) => type === 'code',
      runner: (state, node, type) => {
        state.openNode(type, { language: (node.lang as string) ?? '', meta: (node.meta as string) ?? '' });
        if (node.value) state.addText(node.value as string);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'code_block',
      runner: (state, node) => {
        const text = node.content.firstChild?.text || '';
        // Crepe 의 수식 블록은 language 가 latex 인 code_block 으로 표현된다 → $$ 블록으로 저장
        if (String(node.attrs.language).toLowerCase() === 'latex') {
          state.addNode('math', undefined, text);
          return;
        }
        state.addNode('code', undefined, text, { lang: node.attrs.language, meta: node.attrs.meta || null });
      },
    },
  };
});

export function preserveBlogMarkdown(editor: Editor): void {
  editor.use(codeBlockWithMeta);
  editor.config((ctx) => {
    // 목록 기호 '-', 구분선 '---' 로 기존 작성 스타일 유지
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
      ...prev,
      bullet: '-' as const,
      rule: '-' as const,
      emphasis: '*' as const,
      strong: '*' as const,
    }));

    // 이미지 alt(대체 텍스트) 보존. Crepe 기본값은 alt 자리에 크기 비율을 저장한다.
    ctx.update(imageBlockSchema.key, (prev) => (innerCtx) => {
      const base = prev(innerCtx);
      return {
        ...base,
        attrs: { ...base.attrs, alt: { default: '', validate: 'string' } },
        parseMarkdown: {
          match: ({ type }) => type === 'image-block',
          runner: (state, node, type) => {
            state.addNode(type, {
              src: (node.url as string) ?? '',
              caption: (node.title as string) ?? '',
              alt: (node.alt as string) ?? '',
              ratio: 1,
            });
          },
        },
        toMarkdown: {
          match: (node) => node.type.name === 'image-block',
          runner: (state, node) => {
            state.openNode('paragraph');
            state.addNode('image', undefined, undefined, {
              url: node.attrs.src,
              title: node.attrs.caption || null,
              alt: node.attrs.alt || node.attrs.caption || '',
            });
            state.closeNode();
          },
        },
      };
    });
  });
}
