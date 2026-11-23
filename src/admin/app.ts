import { GitHubClient, GitHubError, fileToBase64, textToBase64, type FileChange } from './github';
import { nowWithOffset, parsePost, serializePost, type ParsedPost, type PostMeta } from './frontmatter';
import { createPostEditor, type PostEditor } from './editor';

const POSTS_DIR = 'src/content/posts/';
const AUTH_KEY = 'blog-admin-auth';
const PENDING_IMAGE_DIR = './images/__pending__/';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

interface Auth {
  token: string;
  repo: string;
  branch: string;
}

interface PostSummary {
  path: string;
  sha: string;
  meta: PostMeta;
  editable: boolean;
}

interface PendingImage {
  file: File;
  objectUrl: string;
  committed: boolean;
}

interface EditingState {
  path: string | null; // null = 아직 저장되지 않은 새 글
  sha: string | null;
  parsed: ParsedPost | null;
  editor: PostEditor;
  pendingImages: Map<string, PendingImage>;
  dirty: boolean;
  saving: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const root = $('#admin');
const siteBase = root.dataset.siteBase!.replace(/\/+$/, '');

let client: GitHubClient | null = null;
let posts: PostSummary[] = [];
let editing: EditingState | null = null;
const remoteImageCache = new Map<string, Promise<string>>();

// ---------------------------------------------------------------- 공통 UI

function showView(name: 'login' | 'list' | 'editor') {
  for (const view of ['login', 'list', 'editor']) {
    $(`#view-${view}`).hidden = view !== name;
  }
  $('#admin-user').hidden = name === 'login';
}

let toastTimer: number | undefined;
function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), kind === 'error' ? 8000 : 4000);
}

function errorMessage(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 401) return '토큰이 유효하지 않거나 만료되었습니다. 다시 로그인하세요.';
    if (error.status === 403) return `권한이 없습니다: ${error.message}`;
    if (error.status === 404) return `리포지토리 또는 파일을 찾을 수 없습니다: ${error.message}`;
    if (error.status === 409 || error.status === 422) return `다른 곳에서 먼저 변경되었습니다. 목록을 새로고침한 뒤 다시 시도하세요. (${error.message})`;
    return `GitHub 오류 (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const postId = (path: string) => path.slice(POSTS_DIR.length).replace(/\.mdx?$/, '');
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const baseNameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.mdx?$/, '');

function toInputDateTime(value: string): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function formatListDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ko-KR');
}

// ---------------------------------------------------------------- 로그인

function loadAuth(): Auth | null {
  const raw = sessionStorage.getItem(AUTH_KEY) ?? localStorage.getItem(AUTH_KEY);
  try {
    return raw ? (JSON.parse(raw) as Auth) : null;
  } catch {
    return null;
  }
}

function clearAuth() {
  sessionStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(AUTH_KEY);
}

async function login(auth: Auth, remember: boolean | null) {
  const candidate = new GitHubClient(auth.token, auth.repo, auth.branch);
  const user = await candidate.verify();
  client = candidate;
  if (remember !== null) {
    clearAuth();
    (remember ? localStorage : sessionStorage).setItem(AUTH_KEY, JSON.stringify(auth));
  }
  $('#admin-login-name').textContent = `${user.login} · ${auth.repo}`;
}

function setupLoginForm() {
  const form = $<HTMLFormElement>('#login-form');
  $<HTMLInputElement>('#login-repo').value = root.dataset.defaultRepo ?? '';
  $<HTMLInputElement>('#login-branch').value = root.dataset.defaultBranch || 'main';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button')!;
    button.disabled = true;
    try {
      await login(
        {
          token: $<HTMLInputElement>('#login-token').value.trim(),
          repo: $<HTMLInputElement>('#login-repo').value.trim(),
          branch: $<HTMLInputElement>('#login-branch').value.trim() || 'main',
        },
        $<HTMLInputElement>('#login-remember').checked,
      );
      $<HTMLInputElement>('#login-token').value = '';
      $('#toast').hidden = true;
      await route();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    if (!(await confirmLeave())) return;
    clearAuth();
    client = null;
    posts = [];
    location.hash = '';
    showView('login');
  });
}

// ---------------------------------------------------------------- 글 목록

async function loadPosts() {
  const files = (await client!.listFiles(POSTS_DIR)).filter((file) => /\.mdx?$/.test(file.path));
  const results: PostSummary[] = [];
  const queue = [...files];
  // 동시에 6개씩 읽기
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const { meta } = parsePost(await client!.readText(file.sha));
        results.push({ path: file.path, sha: file.sha, meta, editable: file.path.endsWith('.md') });
      }
    }),
  );
  posts = results.sort((a, b) => new Date(b.meta.date).getTime() - new Date(a.meta.date).getTime());
  updateCategorySuggestions();
}

function updateCategorySuggestions() {
  const categories = new Set<string>();
  const tags = new Set<string>();
  for (const post of posts) {
    const segments = post.meta.category.split('/').map((s) => s.trim()).filter(Boolean);
    segments.forEach((_, i) => categories.add(segments.slice(0, i + 1).join('/')));
    post.meta.tags.forEach((tag) => tags.add(tag));
  }
  $('#category-options').innerHTML = [...categories].sort().map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  $('#tag-suggestions').textContent = tags.size ? `기존 태그: ${[...tags].sort().join(', ')}` : '';
}

function renderPostList() {
  const keyword = $<HTMLInputElement>('#post-filter').value.trim().toLowerCase();
  const filtered = posts.filter((post) =>
    [post.meta.title, post.meta.category, post.path, ...post.meta.tags].join(' ').toLowerCase().includes(keyword),
  );
  $('#post-count').textContent = `${filtered.length} / ${posts.length}개`;
  $('#post-list').innerHTML = filtered.length
    ? filtered
        .map(
          (post) => `
      <li class="admin-post">
        <div class="admin-post-main">
          <div class="admin-post-meta">
            <span class="admin-post-category">${escapeHtml(post.meta.category)}</span>
            <span>${escapeHtml(formatListDate(post.meta.date))}</span>
            ${post.meta.draft ? '<span class="draft-badge">비공개</span>' : ''}
            ${post.editable ? '' : '<span class="draft-badge mdx">MDX</span>'}
          </div>
          ${
            post.editable
              ? `<a class="admin-post-title" href="#edit=${encodeURIComponent(post.path)}">${escapeHtml(post.meta.title || '(제목 없음)')}</a>`
              : `<span class="admin-post-title" title="MDX 파일은 코드 에디터에서 수정하세요">${escapeHtml(post.meta.title)}</span>`
          }
          <div class="admin-post-path">${escapeHtml(post.path.slice(POSTS_DIR.length))}</div>
        </div>
        <div class="admin-post-actions">
          ${post.meta.draft ? '' : `<a class="btn" href="${siteBase}/posts/${postId(post.path)}/" target="_blank" rel="noopener">보기</a>`}
          ${post.editable ? `<a class="btn" href="#edit=${encodeURIComponent(post.path)}">편집</a>` : ''}
          <button class="btn danger" type="button" data-delete="${escapeHtml(post.path)}">삭제</button>
        </div>
      </li>`,
        )
        .join('')
    : '<li class="admin-empty">글이 없습니다.</li>';
}

async function showList(reload: boolean) {
  showView('list');
  if (reload || posts.length === 0) {
    $('#post-list').innerHTML = '<li class="admin-empty">불러오는 중…</li>';
    await loadPosts();
  }
  renderPostList();
}

function setupList() {
  $('#post-filter').addEventListener('input', renderPostList);
  $('#refresh-posts').addEventListener('click', () => showList(true).catch((e) => toast(errorMessage(e), 'error')));
  $('#post-list').addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete]');
    if (!button) return;
    const post = posts.find((p) => p.path === button.dataset.delete);
    if (!post) return;
    button.disabled = true;
    try {
      if (await deletePost(post.path, post.sha, post.meta.title)) await showList(true);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- 삭제

async function deletePost(path: string, loadedSha: string, title: string): Promise<boolean> {
  const imageDir = `${dirOf(path)}/images/${baseNameOf(path)}/`;
  const images = (await client!.listFiles(imageDir)).map((file) => file.path);
  const detail = images.length ? `\n이 글의 이미지 ${images.length}개도 함께 삭제됩니다.` : '';
  if (!confirm(`"${title}" 글을 삭제할까요?${detail}\n(Git 기록에는 남아 있어 복구할 수 있습니다)`)) return false;

  const currentSha = await client!.fileSha(path);
  if (currentSha !== loadedSha) throw new Error('다른 곳에서 글이 변경되었습니다. 목록을 새로고침한 뒤 다시 시도하세요.');

  const changes: FileChange[] = [path, ...images].map((p) => ({ path: p, content: null }));
  await client!.commit(changes, `delete: ${title}`);
  posts = posts.filter((p) => p.path !== path);
  toast('삭제했습니다. 1~2분 후 블로그에 반영됩니다.');
  return true;
}

// ---------------------------------------------------------------- 에디터

function readForm(): PostMeta {
  const dateValue = $<HTMLInputElement>('#meta-date').value;
  return {
    title: $<HTMLInputElement>('#meta-title').value.trim(),
    description: $<HTMLInputElement>('#meta-description').value.trim(),
    category: $<HTMLInputElement>('#meta-category')
      .value.split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('/'),
    tags: $<HTMLInputElement>('#meta-tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    date: dateValue ? nowWithOffset(new Date(dateValue)) : nowWithOffset(),
    updated: editing?.parsed?.meta.updated ?? '',
    draft: !$<HTMLInputElement>('#meta-publish').checked,
  };
}

function fillForm(meta: PostMeta | null, path: string | null) {
  $<HTMLInputElement>('#meta-title').value = meta?.title ?? '';
  $<HTMLInputElement>('#meta-description').value = meta?.description ?? '';
  $<HTMLInputElement>('#meta-category').value = meta?.category ?? '';
  $<HTMLInputElement>('#meta-tags').value = meta?.tags.join(', ') ?? '';
  $<HTMLInputElement>('#meta-date').value = toInputDateTime(meta?.date ?? '');
  $<HTMLInputElement>('#meta-publish').checked = meta ? !meta.draft : false;

  const slug = $<HTMLInputElement>('#meta-slug');
  slug.value = path ? postId(path) : '';
  slug.disabled = path !== null;
  $('#meta-slug-hint').textContent = path ? '저장된 글의 경로(URL)는 바뀌지 않습니다.' : '영문 소문자, 숫자, -, / 만 사용. 예: spring/jpa-n-plus-1';
  $('#delete-post').hidden = path === null;
  updatePublishLabel();
}

function updatePublishLabel() {
  $('#publish-label').textContent = $<HTMLInputElement>('#meta-publish').checked ? '공개' : '비공개';
}

function setDirty(dirty: boolean) {
  if (!editing) return;
  editing.dirty = dirty;
  $('#save-status').textContent = dirty ? '저장되지 않은 변경 사항' : '';
}

async function confirmLeave(): Promise<boolean> {
  if (!editing?.dirty) return true;
  return confirm('저장하지 않은 변경 사항이 있습니다. 나갈까요?');
}

async function closeEditor() {
  if (!editing) return;
  editing.pendingImages.forEach((image) => URL.revokeObjectURL(image.objectUrl));
  await editing.editor.destroy();
  editing = null;
  $('#editor-root').innerHTML = '';
}

function sanitizeFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '.png';
  const stem = (dot > 0 ? name.slice(0, dot) : name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${stem || 'image'}-${Date.now().toString(36)}${ext}`;
}

async function openEditor(path: string | null) {
  await closeEditor();
  showView('editor');

  let parsed: ParsedPost | null = null;
  let sha: string | null = null;
  if (path) {
    $('#editor-root').innerHTML = '<p class="admin-empty">불러오는 중…</p>';
    const fileSha = await client!.fileSha(path);
    if (!fileSha) throw new Error('글을 찾을 수 없습니다. 목록을 새로고침하세요.');
    sha = fileSha;
    parsed = parsePost(await client!.readText(fileSha));
    $('#editor-root').innerHTML = '';
  }
  fillForm(parsed?.meta ?? null, path);

  const pendingImages = new Map<string, PendingImage>();
  const editor = await createPostEditor({
    root: $('#editor-root'),
    markdown: parsed?.body.trim() ?? '',
    onChange: () => setDirty(true),
    onUpload: async (file) => {
      if (!file.type.startsWith('image/')) throw new Error('이미지 파일만 올릴 수 있습니다.');
      const token = `${PENDING_IMAGE_DIR}${sanitizeFileName(file.name)}`;
      pendingImages.set(token, { file, objectUrl: URL.createObjectURL(file), committed: false });
      return token;
    },
    // 에디터 생성 중에도 호출되므로 editing 상태 대신 지역 변수를 넘긴다
    resolveImage: (src) => resolveImage(src, editing?.path ?? path, pendingImages),
  });

  editing = { path, sha, parsed, editor, pendingImages, dirty: false, saving: false };
  setDirty(false);
  if (!path) $('#meta-title').focus();
}

function resolveImage(src: string, postPath: string | null, pendingImages: Map<string, PendingImage>): Promise<string> | string {
  const pending = pendingImages.get(src);
  if (pending) return pending.objectUrl;
  if (/^(https?:|data:|blob:)/.test(src) || !postPath) return src;

  // 저장소 안의 이미지 → 경로 계산 후 GitHub 에서 받아서 표시
  let repoPath: string;
  if (src.startsWith('/')) {
    repoPath = `public${src}`;
  } else {
    const parts = dirOf(postPath).split('/');
    for (const segment of src.split('/')) {
      if (segment === '..') parts.pop();
      else if (segment !== '.' && segment !== '') parts.push(segment);
    }
    repoPath = parts.join('/');
  }
  if (!remoteImageCache.has(repoPath)) {
    remoteImageCache.set(
      repoPath,
      client!.readRaw(repoPath).then((blob) => URL.createObjectURL(blob)),
    );
  }
  return remoteImageCache.get(repoPath)!.catch(() => src);
}

async function savePost() {
  if (!editing || editing.saving) return;
  const meta = readForm();
  if (!meta.title) return toast('제목을 입력하세요.', 'error');
  if (!meta.category) return toast('카테고리를 입력하세요.', 'error');

  let path = editing.path;
  if (!path) {
    const slug = $<HTMLInputElement>('#meta-slug').value.trim();
    if (!SLUG_PATTERN.test(slug)) return toast('파일 경로는 영문 소문자, 숫자, -, / 만 사용할 수 있습니다.', 'error');
    path = `${POSTS_DIR}${slug}.md`;
  }

  editing.saving = true;
  $<HTMLButtonElement>('#save-post').disabled = true;
  $('#save-status').textContent = '저장 중…';
  try {
    const currentSha = await client!.fileSha(path);
    if (editing.path === null && currentSha !== null) throw new Error('같은 경로의 글이 이미 있습니다. 다른 경로를 입력하세요.');
    if (editing.path !== null && currentSha !== editing.sha) {
      throw new Error('다른 곳에서 이 글이 수정되었습니다. 내용을 복사해 두고 글을 다시 열어 주세요.');
    }

    // 공개된 글을 수정하면 수정일 기록
    if (editing.path !== null && !meta.draft) meta.updated = nowWithOffset();

    const imageDir = `./images/${baseNameOf(path)}/`;
    let body = editing.editor.getMarkdown();
    const changes: FileChange[] = [];
    for (const [token, image] of editing.pendingImages) {
      if (!body.includes(token)) continue;
      body = body.split(token).join(token.replace(PENDING_IMAGE_DIR, imageDir));
      if (!image.committed) {
        changes.push({
          path: `${dirOf(path)}/${token.replace(PENDING_IMAGE_DIR, imageDir).slice(2)}`,
          content: { base64: await fileToBase64(image.file) },
        });
      }
    }

    const content = serializePost(meta, body, editing.parsed?.document);
    changes.unshift({ path, content: { base64: textToBase64(content) } });
    await client!.commit(changes, `${editing.path ? 'update' : 'post'}: ${meta.title}`);

    editing.pendingImages.forEach((image) => (image.committed = true));
    editing.sha = await client!.fileSha(path);
    editing.parsed = parsePost(content);
    const isNew = editing.path === null;
    editing.path = path;
    fillForm(editing.parsed.meta, path);
    setDirty(false);

    const summary: PostSummary = { path, sha: editing.sha!, meta: editing.parsed.meta, editable: true };
    posts = [summary, ...posts.filter((p) => p.path !== path)].sort(
      (a, b) => new Date(b.meta.date).getTime() - new Date(a.meta.date).getTime(),
    );
    updateCategorySuggestions();
    if (isNew) {
      history.replaceState(null, '', `#edit=${encodeURIComponent(path)}`);
      currentHash = location.hash;
    }
    toast(meta.draft ? '저장했습니다. (비공개)' : '저장했습니다. 1~2분 후 블로그에 반영됩니다.');
  } catch (error) {
    $('#save-status').textContent = '저장 실패';
    toast(errorMessage(error), 'error');
  } finally {
    if (editing) editing.saving = false;
    $<HTMLButtonElement>('#save-post').disabled = false;
  }
}

function setupEditor() {
  $('#save-post').addEventListener('click', savePost);
  $('#meta-publish').addEventListener('change', updatePublishLabel);
  $('#view-editor .admin-meta').addEventListener('input', () => setDirty(true));
  $('#delete-post').addEventListener('click', async () => {
    if (!editing?.path || !editing.sha) return;
    try {
      if (await deletePost(editing.path, editing.sha, editing.parsed?.meta.title ?? editing.path)) {
        editing.dirty = false;
        location.hash = '';
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  });

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && editing) {
      event.preventDefault();
      savePost();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (editing?.dirty) event.preventDefault();
  });
}

// ---------------------------------------------------------------- 라우팅

let currentHash = location.hash;

async function route() {
  if (!client) return showView('login');
  const hash = location.hash;
  try {
    if (hash === '#new') {
      await openEditor(null);
    } else if (hash.startsWith('#edit=')) {
      await openEditor(decodeURIComponent(hash.slice('#edit='.length)));
    } else {
      await closeEditor();
      await showList(false);
    }
    currentHash = hash;
  } catch (error) {
    toast(errorMessage(error), 'error');
    if (error instanceof GitHubError && error.status === 401) {
      clearAuth();
      client = null;
      showView('login');
    }
  }
}

window.addEventListener('hashchange', async () => {
  if (location.hash === currentHash) return;
  if (!(await confirmLeave())) {
    history.replaceState(null, '', currentHash || location.pathname);
    return;
  }
  if (editing) editing.dirty = false;
  await route();
});

// ---------------------------------------------------------------- 시작

setupLoginForm();
setupList();
setupEditor();

const savedAuth = loadAuth();
if (savedAuth) {
  login(savedAuth, null)
    .then(route)
    .catch((error) => {
      clearAuth();
      showView('login');
      toast(errorMessage(error), 'error');
    });
} else {
  showView('login');
}
