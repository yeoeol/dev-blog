// base 경로(GitHub Pages 프로젝트 사이트의 /repo-name 등)를 반영한 내부 링크 생성
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

export function withBase(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE}${normalized}`;
}
