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
  imageRewrites: [string, string][];
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
  if (name !== 'list') window.clearTimeout(deployPollTimer);
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
            ${post.meta.draft ? '<span class="draft-badge">임시저장</span>' : ''}
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
  refreshDeployStatus();
}

function setupList() {
  $('#post-filter').addEventListener('input', renderPostList);
  $('#refresh-posts').addEventListener('click', () => showList(true).catch((e) => toast(errorMessage(e), 'error')));
  $('#deploy-now').addEventListener('click', deployNow);
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

// ---------------------------------------------------------------- 배포

const DEPLOY_WORKFLOW = 'deploy.yml';
const RUNNING_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
let deployPollTimer: number | undefined;

const stripSkipCi = (message: string) => message.split('\n')[0].replace(/\s*\[skip ci\]\s*$/, '');

async function refreshDeployStatus() {
  window.clearTimeout(deployPollTimer);
  const status = $('#deploy-status');
  const button = $<HTMLButtonElement>('#deploy-now');
  const pendingList = $('#deploy-pending');
  try {
    const [latest] = await client!.workflowRuns(DEPLOY_WORKFLOW);
    const [lastSuccess] = await client!.workflowRuns(DEPLOY_WORKFLOW, { status: 'success' });
    const pending = lastSuccess ? await client!.commitsSince(lastSuccess.head_sha) : null;

    if (latest && RUNNING_STATUSES.includes(latest.status)) {
      status.innerHTML = `배포 진행 중… <a href="${latest.html_url}" target="_blank" rel="noopener">진행 상황 보기</a>`;
      button.disabled = true;
      deployPollTimer = window.setTimeout(refreshDeployStatus, 10_000);
    } else {
      const failed = latest?.conclusion && latest.conclusion !== 'success'
        ? ` · <a href="${latest.html_url}" target="_blank" rel="noopener">마지막 배포 실패</a>`
        : '';
      if (pending === null) status.innerHTML = `아직 배포된 적이 없습니다.${failed}`;
      else if (pending.length === 0) status.innerHTML = `모든 변경 사항이 블로그에 반영되어 있습니다.${failed}`;
      else status.innerHTML = `배포되지 않은 변경 <b>${pending.length}건</b>${failed}`;
      button.disabled = pending !== null && pending.length === 0;
    }

    pendingList.innerHTML = (pending ?? [])
      .slice()
      .reverse()
      .map((commit) => `<li>${escapeHtml(stripSkipCi(commit.message))} <span class="admin-muted">${escapeHtml(new Date(commit.date).toLocaleString('ko-KR'))}</span></li>`)
      .join('');
    $('#deploy-pending-wrap').hidden = !pending || pending.length === 0;
  } catch (error) {
    status.textContent =
      error instanceof GitHubError && error.status === 403
        ? '배포 상태를 볼 수 없습니다. 토큰에 Actions 권한(Read and write)을 추가하세요.'
        : `배포 상태를 불러오지 못했습니다: ${errorMessage(error)}`;
    button.disabled = false;
  }
}

async function deployNow() {
  const button = $<HTMLButtonElement>('#deploy-now');
  button.disabled = true;
  try {
    const run = await client!.runWorkflow(DEPLOY_WORKFLOW);
    toast('배포를 시작했습니다. 1~2분 후 블로그에 반영됩니다.');
    $('#deploy-status').innerHTML = `배포 진행 중… <a href="${run.html_url}" target="_blank" rel="noopener">진행 상황 보기</a>`;
    deployPollTimer = window.setTimeout(refreshDeployStatus, 10_000);
  } catch (error) {
    button.disabled = false;
    toast(
      error instanceof GitHubError && error.status === 403
        ? '배포 권한이 없습니다. 토큰에 Actions 권한(Read and write)을 추가하세요.'
        : errorMessage(error),
      'error',
    );
  }
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
  await client!.commit(changes, `delete: ${title} [skip ci]`);
  posts = posts.filter((p) => p.path !== path);
  toast('삭제했습니다. "지금 배포"를 누르면 블로그에 반영됩니다.');
  return true;
}

// ---------------------------------------------------------------- 에디터

const DRAFT_DIR = `${POSTS_DIR}drafts/`;

/** 경로를 정하지 않은 임시저장 글의 자동 경로 */
function autoDraftPath(): string {
  const stamp = nowWithOffset().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${DRAFT_DIR}${stamp}.md`;
}

const isAutoDraftPath = (path: string | null) => path !== null && path.startsWith(DRAFT_DIR);
/** 발행된 적 있는 글(= 현재 공개 상태로 저장된 글)은 경로를 바꾸지 않는다 */
const isPublished = () => editing?.parsed?.meta.draft === false;

function readForm(draft: boolean): PostMeta {
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
    draft,
  };
}

function fillForm(meta: PostMeta | null, path: string | null) {
  $<HTMLInputElement>('#meta-title').value = meta?.title ?? '';
  $<HTMLInputElement>('#meta-description').value = meta?.description ?? '';
  $<HTMLInputElement>('#meta-category').value = meta?.category ?? '';
  $<HTMLInputElement>('#meta-tags').value = meta?.tags.join(', ') ?? '';
  $<HTMLInputElement>('#meta-date').value = toInputDateTime(meta?.date ?? '');

  const published = meta?.draft === false;
  const slug = $<HTMLInputElement>('#meta-slug');
  slug.value = path && !isAutoDraftPath(path) ? postId(path) : '';
  slug.disabled = published;
  $('#meta-slug-hint').textContent = published
    ? '발행된 글의 경로(URL)는 바뀌지 않습니다.'
    : '발행 전까지 비워 둘 수 있습니다. 영문 소문자, 숫자, -, / 만 사용. 예: spring/jpa-n-plus-1';

  $('#post-state').textContent = path === null ? '새 글' : published ? '발행된 글' : '임시저장 글';
  $('#post-state').dataset.state = path === null ? 'new' : published ? 'published' : 'draft';
  $('#save-draft').hidden = published;
  $('#unpublish-post').hidden = !published;
  $('#publish-post').textContent = published ? '저장' : '발행';
  $('#delete-post').hidden = path === null;
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

/** 새 글 화면에서 이어 쓸 수 있는 임시저장 목록 */
async function renderDraftPanel(show: boolean) {
  const panel = $('#draft-panel');
  panel.hidden = true;
  if (!show) return;
  if (posts.length === 0) await loadPosts();
  const drafts = posts.filter((post) => post.meta.draft && post.editable);
  if (drafts.length === 0) return;
  $('#draft-panel-count').textContent = `${drafts.length}개`;
  $('#draft-list').innerHTML = drafts
    .map(
      (post) => `
      <li>
        <a href="#edit=${encodeURIComponent(post.path)}">
          <strong>${escapeHtml(post.meta.title || '(제목 없음)')}</strong>
          <span class="admin-muted">${escapeHtml(post.meta.category)} · ${escapeHtml(formatListDate(post.meta.updated || post.meta.date))}</span>
        </a>
      </li>`,
    )
    .join('');
  panel.hidden = false;
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
  await renderDraftPanel(path === null);

  const pendingImages = new Map<string, PendingImage>();
  const imageRewrites: [string, string][] = [];
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
    resolveImage: (src) => resolveImage(applyRewrites(src, imageRewrites), editing?.path ?? path, pendingImages),
  });

  editing = { path, sha, parsed, editor, pendingImages, imageRewrites, dirty: false, saving: false };
  setDirty(false);
  if (!path) $('#meta-title').focus();
}

/** 글 경로가 바뀐 뒤에도 에디터 안의 예전 이미지 경로를 새 경로로 바꿔 준다 */
function applyRewrites(text: string, rewrites: [string, string][]): string {
  return rewrites.reduce((result, [from, to]) => result.split(from).join(to), text);
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

type SaveMode = 'draft' | 'publish' | 'unpublish';

const SAVE_BUTTONS = ['#save-draft', '#publish-post', '#unpublish-post', '#delete-post'];

async function savePost(mode: SaveMode) {
  if (!editing || editing.saving) return;
  const draft = mode !== 'publish';
  const meta = readForm(draft);
  if (!meta.title) return toast('제목을 입력하세요.', 'error');
  if (!draft && !meta.category) return toast('발행하려면 카테고리를 입력하세요.', 'error');
  if (draft && !meta.category) meta.category = '미분류';

  // 저장할 경로 결정: 발행 전 글만 경로를 바꿀 수 있다
  const slug = $<HTMLInputElement>('#meta-slug').value.trim();
  let path: string;
  if (isPublished()) {
    path = editing.path!;
  } else if (slug) {
    if (!SLUG_PATTERN.test(slug)) return toast('파일 경로는 영문 소문자, 숫자, -, / 만 사용할 수 있습니다.', 'error');
    if (`${POSTS_DIR}${slug}.md`.startsWith(DRAFT_DIR)) return toast('drafts/ 는 임시저장용 경로입니다. 다른 경로를 입력하세요.', 'error');
    path = `${POSTS_DIR}${slug}.md`;
  } else if (!draft) {
    $<HTMLInputElement>('#meta-slug').focus();
    return toast('발행하려면 파일 경로(URL)를 입력하세요.', 'error');
  } else {
    path = editing.path ?? autoDraftPath();
  }
  const previousPath = editing.path;
  const moving = previousPath !== null && previousPath !== path;

  editing.saving = true;
  SAVE_BUTTONS.forEach((selector) => ($<HTMLButtonElement>(selector).disabled = true));
  $('#save-status').textContent = '저장 중…';
  try {
    if (previousPath !== null) {
      const currentSha = await client!.fileSha(previousPath);
      if (currentSha !== editing.sha) {
        throw new Error('다른 곳에서 이 글이 수정되었습니다. 내용을 복사해 두고 글을 다시 열어 주세요.');
      }
    }
    if (previousPath === null || moving) {
      if ((await client!.fileSha(path)) !== null) throw new Error('같은 경로의 글이 이미 있습니다. 다른 경로를 입력하세요.');
    }

    // 발행된 글을 다시 저장하면 수정일 기록
    if (isPublished() && mode === 'publish') meta.updated = nowWithOffset();

    const changes: FileChange[] = [];
    const newImageDir = `./images/${baseNameOf(path)}/`;

    // 경로 변경: 글 파일과 이미지 폴더를 새 경로로 옮긴다 (이미지는 재업로드 없이 기존 내용 재사용)
    if (moving) {
      const oldImageDir = `./images/${baseNameOf(previousPath)}/`;
      const oldImageRepoDir = `${dirOf(previousPath)}/${oldImageDir.slice(2)}`;
      const newImageRepoDir = `${dirOf(path)}/${newImageDir.slice(2)}`;
      for (const file of await client!.listFiles(oldImageRepoDir)) {
        changes.push({ path: `${newImageRepoDir}${file.path.slice(oldImageRepoDir.length)}`, content: { sha: file.sha } });
        changes.push({ path: file.path, content: null });
      }
      changes.push({ path: previousPath, content: null });
      if (oldImageDir !== newImageDir) editing.imageRewrites.push([oldImageDir, newImageDir]);
    }

    let body = applyRewrites(editing.editor.getMarkdown(), editing.imageRewrites);
    const uploadedImages: PendingImage[] = [];
    for (const [token, image] of editing.pendingImages) {
      if (!body.includes(token)) continue;
      const finalPath = token.replace(PENDING_IMAGE_DIR, newImageDir);
      body = body.split(token).join(finalPath);
      if (!image.committed) {
        changes.push({ path: `${dirOf(path)}/${finalPath.slice(2)}`, content: { base64: await fileToBase64(image.file) } });
        uploadedImages.push(image);
      }
    }

    const content = serializePost(meta, body, editing.parsed?.document);
    changes.unshift({ path, content: { base64: textToBase64(content) } });
    const action = { draft: 'draft', publish: isPublished() ? 'update' : 'post', unpublish: 'unpublish' }[mode];
    // [skip ci]: 저장할 때마다 배포하지 않고, 목록 화면의 "지금 배포" 로 한 번에 반영
    await client!.commit(changes, `${action}: ${meta.title} [skip ci]`);

    // 업로드한 이미지는 이후 저장에서 다시 올리지 않는다
    uploadedImages.forEach((image) => (image.committed = true));
    editing.sha = await client!.fileSha(path);
    editing.parsed = parsePost(content);
    editing.path = path;
    fillForm(editing.parsed.meta, path);
    setDirty(false);

    posts = [
      { path, sha: editing.sha!, meta: editing.parsed.meta, editable: true },
      ...posts.filter((p) => p.path !== path && p.path !== previousPath),
    ].sort((a, b) => new Date(b.meta.date).getTime() - new Date(a.meta.date).getTime());
    updateCategorySuggestions();
    if (previousPath !== path) {
      history.replaceState(null, '', `#edit=${encodeURIComponent(path)}`);
      currentHash = location.hash;
      $('#draft-panel').hidden = true;
    }
    toast(
      {
        draft: '임시저장했습니다.',
        publish: '저장했습니다. 목록 화면에서 "지금 배포"를 누르면 블로그에 반영됩니다.',
        unpublish: '발행을 취소하고 임시저장 글로 바꿨습니다. 배포하면 블로그에서 내려갑니다.',
      }[mode],
    );
  } catch (error) {
    $('#save-status').textContent = '저장 실패';
    toast(errorMessage(error), 'error');
  } finally {
    if (editing) editing.saving = false;
    SAVE_BUTTONS.forEach((selector) => ($<HTMLButtonElement>(selector).disabled = false));
  }
}

function setupEditor() {
  $('#save-draft').addEventListener('click', () => savePost('draft'));
  $('#publish-post').addEventListener('click', () => savePost('publish'));
  $('#unpublish-post').addEventListener('click', () => {
    if (confirm('발행을 취소하고 임시저장 글로 바꿀까요?\n배포하면 블로그에서 이 글이 내려갑니다.')) savePost('unpublish');
  });
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
      // 발행된 글은 저장, 그 외에는 임시저장
      savePost(isPublished() ? 'publish' : 'draft');
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
