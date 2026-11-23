import { Crepe } from '@milkdown/crepe';
import { setCodeMirrorTheme } from '@milkdown/crepe/feature/code-mirror';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { blockquoteSchema, clearTextInCurrentBlockCommand, codeBlockSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { Ctx } from '@milkdown/kit/ctx';
import { preserveBlogMarkdown } from './editor-fidelity';

export interface PostEditorOptions {
  root: HTMLElement;
  markdown: string;
  /** 이미지 파일을 받아 마크다운에 들어갈 경로를 돌려준다 */
  onUpload: (file: File) => Promise<string>;
  /** 마크다운의 이미지 경로를 에디터 화면에서 보여줄 URL 로 바꾼다 */
  resolveImage: (src: string) => Promise<string> | string;
  onChange: () => void;
}

export interface PostEditor {
  getMarkdown: () => string;
  destroy: () => Promise<void>;
}

const CALLOUTS = [
  { type: 'NOTE', label: '콜아웃 · 참고', icon: '💡' },
  { type: 'TIP', label: '콜아웃 · 팁', icon: '✅' },
  { type: 'IMPORTANT', label: '콜아웃 · 중요', icon: '📌' },
  { type: 'WARNING', label: '콜아웃 · 경고', icon: '⚠️' },
  { type: 'CAUTION', label: '콜아웃 · 주의', icon: '⛔' },
];

const emojiIcon = (emoji: string) => `<span style="font-size:16px;line-height:1">${emoji}</span>`;

/** 현재 (빈) 블록을 blockquote([첫 줄], [빈 문단]) 으로 바꾸고 커서를 본문 문단으로 옮긴다 */
function insertQuoteBlock(ctx: Ctx, firstLine: string) {
  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const paragraph = paragraphSchema.type(ctx);
  const quote = blockquoteSchema.type(ctx).create(null, [
    paragraph.create(null, state.schema.text(firstLine)),
    paragraph.create(),
  ]);
  const { $from } = state.selection;
  const start = $from.before();
  const tr = state.tr.replaceWith(start, $from.after(), quote);
  // blockquote 시작(1) + 첫 문단(firstLine + 2) + 다음 문단 안쪽(1)
  tr.setSelection(TextSelection.create(tr.doc, start + 1 + firstLine.length + 2 + 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function insertCodeBlock(ctx: Ctx, language: string, content: string) {
  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const { $from } = state.selection;
  const node = codeBlockSchema.type(ctx).create({ language }, state.schema.text(content));
  view.dispatch(state.tr.replaceWith($from.before(), $from.after(), node).scrollIntoView());
}

/**
 * 직렬화된 마크다운 후처리 (코드블록 안은 건드리지 않음)
 * - 인용문 첫 줄의 콜아웃 표시가 \[!NOTE] 로 이스케이프되는 것을 되돌린다.
 * - 빈 문단이 <br /> 한 줄로 저장되는 것을 제거한다.
 */
function normalizeMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fenceMatch[1].startsWith(fence)) fence = null;
      result.push(line);
      continue;
    }
    if (fence !== null) {
      result.push(line);
      continue;
    }
    if (line.trim() === '<br />') {
      if (lines[i + 1] === '') i++;
      continue;
    }
    result.push(line.replace(/^((?:\s*>)+\s*)\\\[!(\w+)\]/, '$1[!$2]'));
  }
  return result.join('\n');
}

export async function createPostEditor(options: PostEditorOptions): Promise<PostEditor> {
  const crepe = new Crepe({
    root: options.root,
    defaultValue: options.markdown,
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: "'/' 를 입력해 블록을 추가하세요", mode: 'block' },
      [Crepe.Feature.ImageBlock]: {
        onUpload: options.onUpload,
        proxyDomURL: options.resolveImage,
        blockUploadButton: '이미지 업로드',
        blockUploadPlaceholderText: '또는 이미지 URL 붙여넣기',
        blockCaptionPlaceholderText: '캡션 입력',
        blockConfirmButton: '확인',
        inlineUploadButton: '업로드',
        inlineUploadPlaceholderText: '또는 이미지 URL 붙여넣기',
        inlineConfirmButton: '확인',
      },
      [Crepe.Feature.CodeMirror]: {
        searchPlaceholder: '언어 검색',
        noResultText: '결과 없음',
        copyText: '복사',
      },
      [Crepe.Feature.LinkTooltip]: { inputPlaceholder: '링크 URL 붙여넣기' },
      [Crepe.Feature.BlockEdit]: {
        textGroup: {
          label: '텍스트',
          text: { label: '텍스트' },
          h1: { label: '제목 1' },
          h2: { label: '제목 2' },
          h3: { label: '제목 3' },
          h4: { label: '제목 4' },
          h5: { label: '제목 5' },
          h6: { label: '제목 6' },
          quote: { label: '인용' },
          divider: { label: '구분선' },
        },
        listGroup: {
          label: '목록',
          bulletList: { label: '글머리 기호 목록' },
          orderedList: { label: '번호 목록' },
          taskList: { label: '할 일 목록' },
        },
        advancedGroup: {
          label: '고급',
          image: { label: '이미지' },
          codeBlock: { label: '코드' },
          table: { label: '표' },
          math: { label: '수식' },
        },
        buildMenu: (builder) => {
          const group = builder.addGroup('blog', '블로그');
          for (const callout of CALLOUTS) {
            group.addItem(`callout-${callout.type.toLowerCase()}`, {
              label: callout.label,
              icon: emojiIcon(callout.icon),
              onRun: (ctx) => insertQuoteBlock(ctx, `[!${callout.type}]`),
            });
          }
          group.addItem('toggle', {
            label: '토글 (접기/펼치기)',
            icon: emojiIcon('▸'),
            onRun: (ctx) => insertQuoteBlock(ctx, '[!toggle]- 토글 제목'),
          });
          group.addItem('mermaid', {
            label: 'Mermaid 다이어그램',
            icon: emojiIcon('🧭'),
            onRun: (ctx) => insertCodeBlock(ctx, 'mermaid', 'flowchart LR\n    A --> B'),
          });
        },
      },
    },
  });

  preserveBlogMarkdown(crepe.editor);
  // 라이트 모드에서는 CodeMirror 기본(밝은) 하이라이트 사용. 다크 모드는 Crepe 기본 테마(One Dark) 유지
  if (!document.documentElement.classList.contains('dark')) {
    crepe.editor.config(setCodeMirrorTheme([]));
  }
  crepe.on((listener) => listener.markdownUpdated(() => options.onChange()));
  await crepe.create();

  return {
    getMarkdown: () => normalizeMarkdown(crepe.getMarkdown()),
    destroy: async () => {
      await crepe.destroy();
    },
  };
}
