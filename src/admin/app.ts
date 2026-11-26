import { GitHubClient, GitHubError, fileToBase64, textToBase64, type BranchCommit, type FileChange } from './github';
import { nowWithOffset, parsePost, serializePost, type ParsedPost, type PostMeta } from './frontmatter';
import { createPostEditor, type PostEditor } from './editor';

const POSTS_DIR = 'src/content/posts/';
const AUTH_KEY = 'blog-admin-auth';
const PENDING_IMAGE_DIR = './images/__pending__/';
/** 관리자 화면의 저장이 쌓이는 작업 브랜치 */
const WORK_BRANCH = 'writing';
/** 글 이름(파일명): 영문 소문자, 숫자, - */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

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
/** 블로그가 배포되는 브랜치 (로그인 화면의 '배포 브랜치') */
let deployBranch = 'main';
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
  const candidate = new GitHubClient(auth.token, auth.repo, WORK_BRANCH);
  const user = await candidate.verify();
  client = candidate;
  deployBranch = auth.branch;
  await prepareWorkBranch();
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
            ${post.meta.private ? '<span class="draft-badge private">비공개</span>' : ''}
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
          ${post.meta.draft || post.meta.private ? '' : `<a class="btn" href="${siteBase}/posts/${postId(post.path)}/" target="_blank" rel="noopener">보기</a>`}
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
    if (reload) await syncWorkBranch();
    await loadPosts();
  }
  renderPostList();
  refreshDeployStatus();
}

function setupList() {
  $('#post-filter').addEventListener('input', renderPostList);
  $('#refresh-posts').addEventListener('click', () => showList(true).catch((e) => toast(errorMessage(e), 'error')));
  $('#deploy-now').addEventListener('click', deployNow);
  $('#deploy-title').addEventListener('input', (event) => {
    (event.target as HTMLInputElement).dataset.edited = 'true';
  });
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

// ---------------------------------------------------------------- 배포 (writing → main squash 병합)

/**
 * 관리자 화면의 저장은 모두 작업 브랜치(writing)에 커밋된다.
 * "main 에 반영" 을 누르면 PR 을 만들어 squash 병합 → main 에는 커밋 1개만 남고, 그 push 로 배포가 1번 돈다.
 * 저장 단위의 세부 커밋 기록은 병합된 PR 에 남는다.
 */
async function prepareWorkBranch() {
  if ((await client!.branchSha(WORK_BRANCH)) === null) {
    const deploySha = await client!.branchSha(deployBranch);
    if (deploySha === null) throw new Error(`배포 브랜치 '${deployBranch}' 를 찾을 수 없습니다.`);
    await client!.createBranch(WORK_BRANCH, deploySha);
    return;
  }
  await syncWorkBranch();
}

/** 로컬에서 main 에 직접 push 한 변경을 작업 브랜치로 가져온다 */
async function syncWorkBranch() {
  const { aheadBy, behindBy } = await client!.compare(deployBranch, WORK_BRANCH);
  if (behindBy === 0) return;
  if (aheadBy === 0) {
    await client!.moveBranch(WORK_BRANCH, (await client!.branchSha(deployBranch))!, false);
    return;
  }
  try {
    await client!.mergeBranch(WORK_BRANCH, deployBranch, `Merge ${deployBranch} into ${WORK_BRANCH}`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 409) {
      throw new Error(
        `${deployBranch} 와 ${WORK_BRANCH} 에서 같은 파일이 서로 다르게 수정되어 자동으로 합치지 못했습니다. 로컬에서 ${WORK_BRANCH} 브랜치에 ${deployBranch} 를 병합해 충돌을 해결해 주세요.`,
      );
    }
    throw error;
  }
}

const firstLine = (message: string) => message.split('\n')[0];

/** main 동기화용 병합 커밋을 뺀, 글 작업 커밋만 */
async function pendingCommits(): Promise<BranchCommit[]> {
  const { commits } = await client!.compare(deployBranch, WORK_BRANCH);
  return commits.filter((commit) => !commit.isMerge);
}

/** "post: 제목", "update: 제목" 형태의 커밋들에서 글 제목을 모아 기본 커밋 메시지를 만든다 */
function defaultSquashTitle(commits: BranchCommit[]): string {
  const titles = [...new Set(commits.map((c) => firstLine(c.message).replace(/^\w+:\s*/, '')))].reverse();
  const shown = titles.slice(0, 3).join(', ');
  return `글 업데이트: ${shown}${titles.length > 3 ? ` 외 ${titles.length - 3}개` : ''}`;
}

async function refreshDeployStatus() {
  const status = $('#deploy-status');
  const button = $<HTMLButtonElement>('#deploy-now');
  try {
    const commits = await pendingCommits();
    status.innerHTML = commits.length
      ? `${escapeHtml(deployBranch)} 에 반영되지 않은 커밋 <b>${commits.length}개</b>`
      : `모든 변경 사항이 ${escapeHtml(deployBranch)} 에 반영되어 있습니다.`;
    button.disabled = commits.length === 0;
    // 직접 입력한 커밋 메시지는 덮어쓰지 않는다
    const titleInput = $<HTMLInputElement>('#deploy-title');
    if (!titleInput.dataset.edited) titleInput.value = commits.length ? defaultSquashTitle(commits) : '';
    $('#deploy-form').hidden = commits.length === 0;
    $('#deploy-pending').innerHTML = commits
      .slice()
      .reverse()
      .map((c) => `<li>${escapeHtml(firstLine(c.message))} <span class="admin-muted">${escapeHtml(new Date(c.date).toLocaleString('ko-KR'))}</span></li>`)
      .join('');
  } catch (error) {
    status.textContent = `반영 상태를 불러오지 못했습니다: ${errorMessage(error)}`;
  }
}

async function waitUntilMergeable(number: number): Promise<boolean> {
  // mergeable 이 null 이면 GitHub 가 아직 계산 중 → 잠시 후 다시 조회
  for (let attempt = 0; attempt < 10; attempt++) {
    const pull = await client!.getPullRequest(number);
    if (pull.mergeable !== null) return pull.mergeable;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('GitHub 가 병합 가능 여부를 아직 계산 중입니다. 잠시 후 다시 시도하세요.');
}

async function deployNow() {
  const title = $<HTMLInputElement>('#deploy-title').value.trim();
  if (!title) return toast('main 에 남길 커밋 메시지를 입력하세요.', 'error');

  const button = $<HTMLButtonElement>('#deploy-now');
  button.disabled = true;
  $('#deploy-status').textContent = `${deployBranch} 에 squash 병합 중…`;
  try {
    await syncWorkBranch();
    const commits = await pendingCommits();
    if (commits.length === 0) {
      toast('반영할 변경 사항이 없습니다.');
      return;
    }
    const body = commits.map((c) => `- ${firstLine(c.message)}`).join('\n');

    const pull =
      (await client!.findOpenPullRequest(WORK_BRANCH, deployBranch)) ??
      (await client!.createPullRequest(WORK_BRANCH, deployBranch, title, `관리자 화면에서 작성한 변경 사항\n\n${body}`));
    if (!(await waitUntilMergeable(pull.number))) {
      throw new Error(`자동으로 병합할 수 없습니다(충돌). PR 에서 확인하세요: ${pull.html_url}`);
    }
    const { head } = await client!.getPullRequest(pull.number);
    const mergeSha = await client!.squashMerge(pull.number, head.sha, title, body);

    // 작업 브랜치를 main 과 같은 지점으로 되돌린다 (세부 커밋 기록은 병합된 PR 에 남아 있음)
    if ((await client!.branchSha(WORK_BRANCH)) === head.sha) {
      await client!.moveBranch(WORK_BRANCH, mergeSha, true);
    }

    delete $('#deploy-title').dataset.edited;
    toast(`${deployBranch} 에 커밋 1개로 반영했습니다. 1~2분 후 블로그에 반영됩니다.`);
    $('#deploy-result').innerHTML =
      `마지막 반영: <a href="${pull.html_url}" target="_blank" rel="noopener">PR #${pull.number}</a> · ` +
      `<a href="https://github.com/${client!.repo}/actions" target="_blank" rel="noopener">배포 진행 상황</a>`;
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    await refreshDeployStatus();
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
  await client!.commit(changes, `delete: ${title}`);
  posts = posts.filter((p) => p.path !== path);
  toast('삭제했습니다. 목록 화면에서 main 에 반영하면 블로그에서도 지워집니다.');
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

/** 카테고리 "Backend/Spring" → 폴더 "backend/spring" (블로그 카테고리 URL 과 같은 규칙) */
function categoryFolder(category: string): string {
  return category
    .split('/')
    .map((segment) =>
      segment
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^\p{L}\p{N}.+-]/gu, '')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|-+$/g, ''),
    )
    .filter(Boolean)
    .join('/');
}

/** 카테고리 폴더 + 글 이름으로 만든 글 파일 경로. 둘 중 하나라도 없으면 null */
function plannedPath(category: string, name: string): string | null {
  const folder = categoryFolder(category);
  return folder && name ? `${POSTS_DIR}${folder}/${name}.md` : null;
}

/** 발행된 글의 고정 경로 (발행 전이면 null) */
let lockedPostPath: string | null = null;

function updatePathPreview() {
  const hint = $('#meta-slug-hint');
  if (lockedPostPath) {
    hint.textContent = `주소: /posts/${postId(lockedPostPath)}/ — 발행된 글은 카테고리를 바꿔도 주소가 유지됩니다.`;
    return;
  }
  const name = $<HTMLInputElement>('#meta-slug').value.trim();
  if (name && !NAME_PATTERN.test(name)) {
    hint.textContent = '영문 소문자, 숫자, - 만 사용할 수 있습니다.';
    return;
  }
  const planned = plannedPath($<HTMLInputElement>('#meta-category').value, name);
  hint.textContent = planned
    ? `주소: /posts/${postId(planned)}/`
    : '카테고리와 글 이름으로 주소가 정해집니다. 임시저장은 비워 둬도 됩니다.';
}
type PostState = 'new' | 'draft' | 'private' | 'published';

function postState(meta: PostMeta | null | undefined, path: string | null): PostState {
  if (path === null || !meta) return 'new';
  if (meta.draft) return 'draft';
  return meta.private ? 'private' : 'published';
}

/** 발행된 글(블로그에 공개 중인 글)은 경로를 바꾸지 않는다 */
const isPublished = () => editing !== null && postState(editing.parsed?.meta, editing.path) === 'published';

function readForm(mode: SaveMode): PostMeta {
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
    draft: mode === 'draft',
    private: mode === 'private',
  };
}

function fillForm(meta: PostMeta | null, path: string | null) {
  $<HTMLInputElement>('#meta-title').value = meta?.title ?? '';
  $<HTMLInputElement>('#meta-description').value = meta?.description ?? '';
  $<HTMLInputElement>('#meta-category').value = meta?.category ?? '';
  $<HTMLInputElement>('#meta-tags').value = meta?.tags.join(', ') ?? '';
  $<HTMLInputElement>('#meta-date').value = toInputDateTime(meta?.date ?? '');

  const state = postState(meta, path);
  const published = state === 'published';
  const slug = $<HTMLInputElement>('#meta-slug');
  slug.value = path && !isAutoDraftPath(path) ? baseNameOf(path) : '';
  slug.disabled = published;
  lockedPostPath = published ? path : null;
  updatePathPreview();

  $('#post-state').textContent = { new: '새 글', draft: '임시저장 글', private: '비공개 글', published: '발행된 글' }[state];
  $('#post-state').dataset.state = state;
  // 새 글·임시저장: [임시저장] [비공개 저장] [발행] / 비공개: [저장] [발행] / 발행됨: [비공개로 전환] [저장]
  $('#save-draft').hidden = state === 'private' || state === 'published';
  $('#save-private').textContent = { new: '비공개 저장', draft: '비공개 저장', private: '저장', published: '비공개로 전환' }[state];
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

// ---------------------------------------------------------------- 미리보기

let previewRun = 0;

function setPreviewMode(on: boolean) {
  $('#preview').hidden = !on;
  $<HTMLElement>('#view-editor .admin-meta').hidden = on;
  $('#editor-root').hidden = on;
  if (on) $('#draft-panel').hidden = true;
  const button = $('#toggle-preview');
  button.textContent = on ? '편집으로' : '미리보기';
  button.setAttribute('aria-pressed', String(on));
}

const isPreviewing = () => !$('#preview').hidden;

/** 지금 에디터 내용을 블로그에 발행됐을 때와 같은 모습으로 보여 준다 (저장·발행 없이) */
async function showPreview() {
  if (!editing) return;
  const run = ++previewRun;
  const current = editing;
  const meta = readForm('draft');
  setPreviewMode(true);
  window.scrollTo({ top: 0 });

  const segments = meta.category.split('/').filter(Boolean);
  $('#preview-breadcrumb').innerHTML = (segments.length ? segments : ['미분류'])
    .map((segment) => `<a>${escapeHtml(segment)}</a>`)
    .join('<span class="sep">›</span>');
  $('#preview-title').textContent = meta.title || '(제목 없음)';
  $('#preview-lead').textContent = meta.description;
  $('#preview-lead').hidden = meta.description === '';
  $('#preview-date').textContent = new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(new Date(meta.date));
  $('#preview-tags').innerHTML = meta.tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('');
  $('#preview-tags').hidden = meta.tags.length === 0;

  const body = $('#preview-body');
  body.innerHTML = '<p class="admin-empty">미리보기를 만드는 중…</p>';
  try {
    const { renderMarkdown, enhancePreview } = await import('./preview');
    const html = await renderMarkdown(applyRewrites(current.editor.getMarkdown(), current.imageRewrites));
    if (run !== previewRun || editing !== current) return;

    // template 안에서는 이미지가 로드되지 않으므로, 넣기 전에 저장소·업로드 대기 이미지 경로를 표시용 URL 로 바꾼다
    const template = document.createElement('template');
    template.innerHTML = html;
    await Promise.all(
      [...template.content.querySelectorAll('img')].map(async (img) => {
        const src = img.getAttribute('src');
        if (src) img.src = await resolveImage(src, current.path, current.pendingImages);
      }),
    );
    template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener';
    });
    if (run !== previewRun || editing !== current) return;
    body.replaceChildren(template.content);
    await enhancePreview(body);
  } catch (error) {
    body.innerHTML = `<p class="admin-empty">미리보기를 만들지 못했습니다: ${escapeHtml(errorMessage(error))}</p>`;
  }
}

function hidePreview() {
  previewRun++;
  setPreviewMode(false);
  if (editing && editing.path === null) renderDraftPanel(true);
}

async function openEditor(path: string | null) {
  await closeEditor();
  showView('editor');
  setPreviewMode(false);

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

type SaveMode = 'draft' | 'private' | 'publish';

const SAVE_BUTTONS = ['#save-draft', '#save-private', '#publish-post', '#delete-post'];

async function savePost(mode: SaveMode) {
  if (!editing || editing.saving) return;
  const draft = mode === 'draft';
  const wasPublished = isPublished();
  // 비공개·발행은 완성된 글로 보고 카테고리와 경로를 요구한다
  const finishLabel = mode === 'publish' ? '발행' : '비공개 저장';
  const meta = readForm(mode);
  if (!meta.title) return toast('제목을 입력하세요.', 'error');
  if (!draft && !meta.category) return toast(`${finishLabel}하려면 카테고리를 입력하세요.`, 'error');
  const categoryEntered = meta.category !== '';
  if (!categoryEntered) meta.category = '미분류';

  // 저장할 경로 결정: 카테고리 폴더 + 글 이름. 발행된 글은 경로를 바꾸지 않는다
  const name = $<HTMLInputElement>('#meta-slug').value.trim();
  if (name && !NAME_PATTERN.test(name)) return toast('글 이름은 영문 소문자, 숫자, - 만 사용할 수 있습니다.', 'error');
  let path: string;
  const planned = categoryEntered ? plannedPath(meta.category, name) : null;
  if (isPublished()) {
    path = editing.path!;
  } else if (planned) {
    if (planned.startsWith(DRAFT_DIR)) return toast("'drafts' 는 임시저장용 폴더라 카테고리 이름으로 쓸 수 없습니다.", 'error');
    path = planned;
  } else if (!draft) {
    $<HTMLInputElement>('#meta-slug').focus();
    return toast(`${finishLabel}하려면 글 이름(영문)을 입력하세요.`, 'error');
  } else {
    // 임시저장: 카테고리·글 이름이 다 정해지기 전까지는 현재 경로(또는 임시 경로) 유지
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
    if (wasPublished && mode === 'publish') meta.updated = nowWithOffset();

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
    const action = {
      draft: 'draft',
      private: wasPublished ? 'unpublish' : 'private',
      publish: wasPublished ? 'update' : 'post',
    }[mode];
    // 작업 브랜치(writing)에 커밋 → 목록 화면의 "main 에 반영" 으로 한 번에 squash 병합
    await client!.commit(changes, `${action}: ${meta.title}`);

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
        private: wasPublished
          ? '비공개로 전환했습니다. main 에 반영하면 블로그에서 내려갑니다.'
          : '비공개로 저장했습니다. 블로그에는 보이지 않습니다.',
        publish: '저장했습니다. 목록 화면에서 main 에 반영하면 블로그에 올라갑니다.',
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
  $('#save-private').addEventListener('click', () => {
    if (isPublished() && !confirm('이 글을 비공개로 전환할까요?\nmain 에 반영하면 블로그에서 이 글이 내려갑니다.')) return;
    savePost('private');
  });
  $('#view-editor .admin-meta').addEventListener('input', () => setDirty(true));
  $('#meta-category').addEventListener('input', updatePathPreview);
  $('#toggle-preview').addEventListener('click', () => (isPreviewing() ? hidePreview() : showPreview()));
  $('#meta-slug').addEventListener('input', updatePathPreview);
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
      // 현재 상태를 유지한 채 저장: 발행된 글 → 저장, 비공개 글 → 비공개 저장, 그 외 → 임시저장
      const state = postState(editing.parsed?.meta, editing.path);
      savePost(state === 'published' ? 'publish' : state === 'private' ? 'private' : 'draft');
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
