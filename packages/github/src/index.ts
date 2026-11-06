/**
 * P&N — Tích hợp GitHub (§17, §59, §60).
 *
 * Luồng chuẩn §17: tạo branch → sửa file → test → commit → push → mở PR.
 * §60 là ràng buộc cứng: agent KHÔNG được commit thẳng vào branch production.
 * Quy tắc đó cưỡng chế ngay trong client này, không dựa vào việc agent tự giác.
 *
 * Gọi thẳng REST API của GitHub để lớp tích hợp gọn và không phụ thuộc phiên
 * bản SDK. Token do AI Gateway/API Center tiêm vào từ kho secret (§19).
 */

import { branchName, type BranchKind } from '@pn/shared';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly url: string,
  ) {
    super(`GitHub ${status}: ${message}`);
    this.name = 'GitHubError';
  }
}

/** §60 — chặn ghi thẳng vào branch được bảo vệ. */
export class ProtectedBranchError extends Error {
  constructor(readonly branch: string) {
    super(
      `Không được commit trực tiếp vào branch được bảo vệ "${branch}". ` +
        'Hãy tạo branch feature/fix/agent rồi mở pull request (spec §17, §60).',
    );
    this.name = 'ProtectedBranchError';
  }
}

export interface GitHubClientOptions {
  token: string;
  /** Branch không bao giờ được ghi trực tiếp. Mặc định gồm các tên phổ biến. */
  protectedBranches?: string[];
  /** Tổ chức mặc định khi tạo repo mới (§59). */
  defaultOrg?: string | null;
  timeoutMs?: number;
}

export interface FileChange {
  path: string;
  /** Nội dung mới. `null` nghĩa là xoá file. */
  content: string | null;
}

export interface CommitResult {
  branch: string;
  commitSha: string;
  treeSha: string;
  filesChanged: number;
}

export interface PullRequestResult {
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  private: boolean;
}

/** §101, §102 — số liệu GitHub Scout cần để chấm điểm một repo. */
export interface RepoSearchHit {
  fullName: string;
  url: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  /** Ngày đẩy commit gần nhất, ISO. */
  lastCommitAt: string | null;
  license: string | null;
  language: string | null;
  topics: string[];
  archived: boolean;
}

/** Tách `owner/repo` thành hai phần, báo lỗi rõ nếu sai định dạng. */
function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Tên repo phải có dạng "owner/repo", nhận được "${fullName}"`);
  }
  return { owner, repo };
}

export class GitHubClient {
  readonly #token: string;
  readonly #protectedBranches: Set<string>;
  readonly #defaultOrg: string | null;
  readonly #timeoutMs: number;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#protectedBranches = new Set(
      (options.protectedBranches ?? ['main', 'master', 'production', 'release']).map((b) =>
        b.toLowerCase(),
      ),
    );
    this.#defaultOrg = options.defaultOrg ?? null;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /* ---------------------------------------------------------------------- */
  /* Kiểm tra kết nối — §48, §68                                            */
  /* ---------------------------------------------------------------------- */

  /** Gọi thật `/user` để xác nhận token còn sống và biết nó thuộc về ai. */
  async testConnection(): Promise<{ ok: boolean; login: string | null; error: string | null }> {
    try {
      const user = await this.#request<{ login: string }>('GET', '/user');
      return { ok: true, login: user.login, error: null };
    } catch (error) {
      return {
        ok: false,
        login: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Repository                                                              */
  /* ---------------------------------------------------------------------- */

  async getRepo(fullName: string): Promise<RepoInfo> {
    const { owner, repo } = splitRepo(fullName);
    const data = await this.#request<{
      full_name: string;
      default_branch: string;
      html_url: string;
      private: boolean;
    }>('GET', `/repos/${owner}/${repo}`);
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
      private: data.private,
    };
  }

  /**
   * §101 — tìm repo cho GitHub Scout.
   *
   * Trả về số liệu thô, KHÔNG kèm đánh giá: việc chấm điểm là của
   * `@pn/knowledge` và phải là hàm thuần để kiểm chứng được (§102).
   *
   * Repo đã lưu trữ (archived) bị loại ngay tại đây — không cần chấm điểm một
   * thứ mà chính chủ đã tuyên bố là ngừng phát triển.
   */
  async searchRepositories(
    query: string,
    options: { limit?: number; sort?: 'stars' | 'updated' } = {},
  ): Promise<RepoSearchHit[]> {
    const limit = Math.min(options.limit ?? 20, 50);
    const params = new URLSearchParams({
      q: query,
      sort: options.sort ?? 'stars',
      order: 'desc',
      per_page: String(limit),
    });

    const data = await this.#request<{
      items?: Array<{
        full_name: string;
        html_url: string;
        description: string | null;
        stargazers_count: number;
        forks_count: number;
        open_issues_count: number;
        pushed_at: string | null;
        license: { spdx_id?: string | null } | null;
        language: string | null;
        topics?: string[];
        archived?: boolean;
      }>;
    }>('GET', `/search/repositories?${params.toString()}`);

    return (data.items ?? [])
      .filter((item) => item.archived !== true)
      .map((item) => ({
        fullName: item.full_name,
        url: item.html_url,
        description: item.description ?? '',
        stars: item.stargazers_count,
        forks: item.forks_count,
        openIssues: item.open_issues_count,
        lastCommitAt: item.pushed_at,
        // GitHub trả 'NOASSERTION' khi không nhận ra giấy phép — coi như không có.
        license:
          item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION'
            ? item.license.spdx_id
            : null,
        language: item.language,
        topics: item.topics ?? [],
        archived: false,
      }));
  }

  /** §101 — đọc README để biết repo có tài liệu dùng được không (§102). */
  async readmeExcerpt(fullName: string, maxChars = 8_000): Promise<string | null> {
    const { owner, repo } = splitRepo(fullName);
    try {
      const data = await this.#request<{ content?: string; encoding?: string }>(
        'GET',
        `/repos/${owner}/${repo}/readme`,
      );
      if (!data.content || data.encoding !== 'base64') return null;
      return Buffer.from(data.content, 'base64').toString('utf8').slice(0, maxChars);
    } catch {
      // Không có README là một dữ kiện, không phải lỗi.
      return null;
    }
  }

  /** §59 — tạo repo cho một dự án mới. Mặc định private để code không lộ. */
  async createRepo(name: string, options: { private?: boolean; description?: string } = {}): Promise<RepoInfo> {
    const body = {
      name,
      private: options.private ?? true,
      description: options.description ?? '',
      auto_init: true, // có commit đầu tiên thì mới tạo branch từ đó được
    };
    const path = this.#defaultOrg ? `/orgs/${this.#defaultOrg}/repos` : '/user/repos';
    const data = await this.#request<{
      full_name: string;
      default_branch: string;
      html_url: string;
      private: boolean;
    }>('POST', path, body);
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
      private: data.private,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Branch — §17                                                            */
  /* ---------------------------------------------------------------------- */

  async getBranchSha(fullName: string, branch: string): Promise<string | null> {
    const { owner, repo } = splitRepo(fullName);
    try {
      const data = await this.#request<{ object: { sha: string } }>(
        'GET',
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      return data.object.sha;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Tạo branch theo quy ước §17 (`feature/* fix/* agent/* release/*`).
   * Nếu branch đã tồn tại thì dùng lại, để agent chạy lại task không bị kẹt.
   */
  async createBranch(
    fullName: string,
    kind: BranchKind,
    subject: string,
    options: { fromBranch?: string; suffix?: string } = {},
  ): Promise<string> {
    const { owner, repo } = splitRepo(fullName);
    const name = branchName(kind, subject, options.suffix);

    const existing = await this.getBranchSha(fullName, name);
    if (existing) return name;

    const base = options.fromBranch ?? (await this.getRepo(fullName)).defaultBranch;
    const baseSha = await this.getBranchSha(fullName, base);
    if (!baseSha) {
      throw new Error(`Branch gốc "${base}" không tồn tại trong ${fullName}`);
    }

    await this.#request('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha: baseSha,
    });
    return name;
  }

  /* ---------------------------------------------------------------------- */
  /* Commit — §17, §60                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Commit nhiều file trong một lần qua Git Data API: tạo blob → tree → commit
   * → cập nhật ref. Làm một commit duy nhất nên lịch sử repo sạch và tương ứng
   * đúng một task.
   *
   * §60 — từ chối ngay nếu branch nằm trong danh sách được bảo vệ.
   */
  async commitFiles(
    fullName: string,
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<CommitResult> {
    this.assertBranchWritable(branch);
    if (files.length === 0) {
      throw new Error('Không có thay đổi nào để commit');
    }

    const { owner, repo } = splitRepo(fullName);
    const parentSha = await this.getBranchSha(fullName, branch);
    if (!parentSha) {
      throw new Error(`Branch "${branch}" không tồn tại trong ${fullName}`);
    }

    const parentCommit = await this.#request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/commits/${parentSha}`,
    );

    // Tạo blob cho từng file có nội dung; file bị xoá thì sha = null trong tree.
    const tree: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
    for (const file of files) {
      if (file.content === null) {
        tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await this.#request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const newTree = await this.#request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: parentCommit.tree.sha,
      tree,
    });

    const commit = await this.#request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [parentSha],
    });

    await this.#request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: commit.sha,
      force: false,
    });

    return { branch, commitSha: commit.sha, treeSha: newTree.sha, filesChanged: files.length };
  }

  /* ---------------------------------------------------------------------- */
  /* Pull request — §17                                                      */
  /* ---------------------------------------------------------------------- */

  async createPullRequest(
    fullName: string,
    input: { head: string; base?: string; title: string; body: string; draft?: boolean },
  ): Promise<PullRequestResult> {
    const { owner, repo } = splitRepo(fullName);
    const base = input.base ?? (await this.getRepo(fullName)).defaultBranch;

    const data = await this.#request<{ number: number; html_url: string }>(
      'POST',
      `/repos/${owner}/${repo}/pulls`,
      {
        title: input.title,
        body: input.body,
        head: input.head,
        base,
        draft: input.draft ?? false,
      },
    );
    return { number: data.number, url: data.html_url, headBranch: input.head, baseBranch: base };
  }

  async listOpenPullRequests(fullName: string): Promise<PullRequestResult[]> {
    const { owner, repo } = splitRepo(fullName);
    const data = await this.#request<
      Array<{ number: number; html_url: string; head: { ref: string }; base: { ref: string } }>
    >('GET', `/repos/${owner}/${repo}/pulls?state=open&per_page=50`);
    return data.map((pr) => ({
      number: pr.number,
      url: pr.html_url,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
    }));
  }

  /**
   * Merge một PR. Việc merge vào branch production vẫn cần phê duyệt ở tầng
   * trên (§27) — client chỉ thi hành, không tự quyết.
   */
  async mergePullRequest(
    fullName: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<{ merged: boolean; sha: string | null }> {
    const { owner, repo } = splitRepo(fullName);
    const data = await this.#request<{ merged: boolean; sha?: string }>(
      'PUT',
      `/repos/${owner}/${repo}/pulls/${number}/merge`,
      { merge_method: method },
    );
    return { merged: data.merged, sha: data.sha ?? null };
  }

  /* ---------------------------------------------------------------------- */
  /* Nội bộ                                                                  */
  /* ---------------------------------------------------------------------- */

  /** §60 — dùng được cả ở ngoài để kiểm tra trước khi giao việc cho agent. */
  assertBranchWritable(branch: string): void {
    if (this.#protectedBranches.has(branch.toLowerCase())) {
      throw new ProtectedBranchError(branch);
    }
  }

  isProtected(branch: string): boolean {
    return this.#protectedBranches.has(branch.toLowerCase());
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${API_ROOT}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'user-agent': 'PN-Digital-Company',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new GitHubError(0, error instanceof Error ? error.message : String(error), url);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitHubError(response.status, text.slice(0, 500), url);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
