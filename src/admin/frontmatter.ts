import { parseDocument, Document } from 'yaml';

export interface PostMeta {
  title: string;
  description: string;
  category: string;
  tags: string[];
  /** 'YYYY-MM-DDTHH:mm:ss+09:00' 형식 문자열 */
  date: string;
  updated: string;
  draft: boolean;
  private: boolean;
}

export interface ParsedPost {
  meta: PostMeta;
  body: string;
  /** 알 수 없는 키까지 보존하기 위한 원본 YAML 문서 */
  document: Document;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parsePost(source: string): ParsedPost {
  const match = source.match(FRONTMATTER);
  // schema 'core' → 날짜를 Date 로 변환하지 않고 문자열 그대로 유지
  const document = parseDocument(match ? match[1] : '', { schema: 'core' });
  const data = (document.toJS() ?? {}) as Record<string, unknown>;
  const asString = (value: unknown) => (value === undefined || value === null ? '' : String(value));

  return {
    meta: {
      title: asString(data.title),
      description: asString(data.description),
      category: asString(data.category),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      date: asString(data.date),
      updated: asString(data.updated),
      draft: data.draft === true,
      private: data.private === true,
    },
    body: match ? source.slice(match[0].length) : source,
    document,
  };
}

export function serializePost(meta: PostMeta, body: string, document: Document = new Document({})): string {
  const set = (key: string, value: unknown, keep: boolean) => {
    if (keep) document.set(key, value);
    else document.delete(key);
  };
  set('title', meta.title, true);
  set('description', meta.description, meta.description !== '');
  set('category', meta.category, true);
  document.set('tags', document.createNode(meta.tags, { flow: true }));
  set('date', meta.date, true);
  set('updated', meta.updated, meta.updated !== '');
  set('draft', meta.draft, meta.draft);
  set('private', meta.private, meta.private);

  const yaml = document.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

/** 현재 시각을 브라우저 시간대 오프셋이 붙은 ISO 문자열로 */
export function nowWithOffset(date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}
