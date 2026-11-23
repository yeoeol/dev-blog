import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

export interface CategoryNode {
  name: string;
  /** 루트부터 이 카테고리까지의 slug 경로. 예: "backend/spring" */
  path: string;
  /** 이 카테고리와 모든 하위 카테고리에 속한 글 수 */
  count: number;
  children: CategoryNode[];
}

/** URL 에 쓸 수 있는 slug. 한글은 유지하고 공백은 '-' 로 바꾼다. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}.+-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function categorySegments(category: string): string[] {
  return category
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function categoryPath(category: string): string {
  return categorySegments(category).map(slugify).join('/');
}

/** 배포 빌드에서는 draft 글을 제외하고 최신순으로 정렬한 글 목록 */
export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => import.meta.env.DEV || !data.draft);
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function buildCategoryTree(posts: Post[]): CategoryNode[] {
  const root: CategoryNode = { name: '', path: '', count: 0, children: [] };

  for (const post of posts) {
    let current = root;
    for (const segment of categorySegments(post.data.category)) {
      const path = current.path ? `${current.path}/${slugify(segment)}` : slugify(segment);
      let child = current.children.find((node) => node.path === path);
      if (!child) {
        child = { name: segment, path, count: 0, children: [] };
        current.children.push(child);
      }
      child.count += 1;
      current = child;
    }
  }

  const sortTree = (nodes: CategoryNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    nodes.forEach((node) => sortTree(node.children));
  };
  sortTree(root.children);
  return root.children;
}

export function flattenCategoryTree(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.flatMap((node) => [node, ...flattenCategoryTree(node.children)]);
}

/** path 카테고리 자신과 하위 카테고리에 속한 글 */
export function postsInCategory(posts: Post[], path: string): Post[] {
  return posts.filter((post) => {
    const postPath = categoryPath(post.data.category);
    return postPath === path || postPath.startsWith(`${path}/`);
  });
}

export function collectTags(posts: Post[]): { name: string; slug: string; count: number }[] {
  const tags = new Map<string, { name: string; slug: string; count: number }>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      const slug = slugify(tag);
      const entry = tags.get(slug) ?? { name: tag, slug, count: 0 };
      entry.count += 1;
      tags.set(slug, entry);
    }
  }
  return [...tags.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(date);
}
