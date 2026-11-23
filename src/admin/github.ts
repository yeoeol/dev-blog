// GitHub REST API 로 블로그 리포지토리의 글 파일을 읽고 커밋한다.
// 커밋은 Git Data API 를 사용해 글 + 이미지 변경을 커밋 1개로 묶는다.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface RepoFile {
  path: string;
  sha: string;
}

/** content 가 null 이면 삭제 */
export interface FileChange {
  path: string;
  content: { base64: string } | null;
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    readonly repo: string,
    readonly branch: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, accept = 'application/vnd.github+json'): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new GitHubError(body.message ?? response.statusText, response.status);
    }
    if (response.status === 204) return undefined as T;
    if (accept.includes('.raw')) return (await response.blob()) as T;
    return response.json() as Promise<T>;
  }

  /** 토큰이 유효하고 리포지토리에 쓰기 권한이 있는지 확인 */
  async verify(): Promise<{ login: string }> {
    const user = await this.request<{ login: string }>('/user');
    const repo = await this.request<{ permissions?: { push?: boolean } }>(`/repos/${this.repo}`);
    if (!repo.permissions?.push) {
      throw new GitHubError(`${this.repo} 에 쓰기 권한이 없는 계정/토큰입니다.`, 403);
    }
    return user;
  }

  async listFiles(prefix: string): Promise<RepoFile[]> {
    const tree = await this.request<{ tree: { path: string; sha: string; type: string }[]; truncated: boolean }>(
      `/repos/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`,
    );
    return tree.tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix));
  }

  async readText(sha: string): Promise<string> {
    const blob = await this.request<{ content: string }>(`/repos/${this.repo}/git/blobs/${sha}`);
    return base64ToText(blob.content);
  }

  /** 파일의 현재 sha. 파일이 없으면 null */
  async fileSha(path: string): Promise<string | null> {
    try {
      const file = await this.request<{ sha: string }>(
        `/repos/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`,
      );
      return file.sha;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  async readRaw(path: string): Promise<Blob> {
    return this.request<Blob>(
      `/repos/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.branch)}`,
      {},
      'application/vnd.github.raw+json',
    );
  }

  /** 여러 파일 추가/수정/삭제를 커밋 하나로 반영 */
  async commit(changes: FileChange[], message: string): Promise<void> {
    const ref = await this.request<{ object: { sha: string } }>(
      `/repos/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`,
    );
    const headSha = ref.object.sha;
    const head = await this.request<{ tree: { sha: string } }>(`/repos/${this.repo}/git/commits/${headSha}`);

    const tree = await Promise.all(
      changes.map(async (change) => {
        if (change.content === null) {
          return { path: change.path, mode: '100644', type: 'blob', sha: null };
        }
        const blob = await this.request<{ sha: string }>(`/repos/${this.repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: change.content.base64, encoding: 'base64' }),
        });
        return { path: change.path, mode: '100644', type: 'blob', sha: blob.sha };
      }),
    );

    const newTree = await this.request<{ sha: string }>(`/repos/${this.repo}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: head.tree.sha, tree }),
    });
    const newCommit = await this.request<{ sha: string }>(`/repos/${this.repo}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
    });
    // force: false → 그 사이 다른 커밋이 push 되었으면 실패한다
    await this.request(`/repos/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    });
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToText(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function fileToBase64(file: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
