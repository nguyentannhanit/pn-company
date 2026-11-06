/**
 * §3.6 — dev phải tự chạy test trước khi báo xong, phải nhìn thấy file và kết
 * quả bước trước rồi mới sửa, và không được xoá toolchain của người khác khi
 * ghi đè package.json.
 *
 * Đều là lỗi đã gặp khi chạy thật: dev giao QA mà chưa chạy `npm test`
 * (13 vòng sửa mù), dev backend ghi đè package.json làm mất vite/vitest, và
 * DevOps viết lại index.html thành trang trần vì không thấy thiết kế.
 *
 * Nay dev viết theo lô: lần gọi đầu lập danh sách tệp, các lần sau viết ≤4 tệp
 * mỗi lần, ghi tiến độ vào `.pn/tien-do/<task>.json` để lượt bị cắt viết tiếp được.
 */

import { describe, expect, it } from 'vitest';

import type { AgentContext } from './contract.js';
import { DeveloperAgent, keyFileContents, mergePackageJson } from './roles.js';

interface Exec {
  command: string;
  exitCode: number;
}

function fakeContext(
  replies: string[],
  testExitCodes: number[],
  options: {
    files?: Record<string, string>;
    priorWork?: AgentContext['priorWork'];
    documents?: AgentContext['documents'];
    fixLoopCount?: number;
    taskId?: string;
    /** Lượt hết giờ ngay sau lần gọi model thứ N. */
    abortAfterCalls?: number;
    /** Mã thoát lần lượt của lệnh khác `npm test` (vd. "npm run typecheck"), theo tiền tố lệnh. */
    commandExits?: Record<string, number[]>;
  } = {},
) {
  const taskId = options.taskId ?? 't1';
  const controller = new AbortController();
  const written = new Map<string, string>(Object.entries(options.files ?? {}));
  const execs: string[] = [];
  const requests: string[] = [];
  const progress: Array<{ pct: number; text: string }> = [];
  let calls = 0;
  const sandbox = {
    async listFiles() {
      return [...written.keys()].filter((path) => !path.startsWith('.pn/'));
    },
    async readFile(path: string) {
      const content = written.get(path);
      if (content === undefined) throw new Error('không có file');
      return content;
    },
    async writeFile(path: string, content: string) {
      written.set(path, content);
    },
    async exec(command: string, args: string[] = []): Promise<Exec & { stdout: string; stderr: string }> {
      const line = [command, ...args].join(' ');
      execs.push(line);
      const other = Object.entries(options.commandExits ?? {}).find(([prefix]) => line.startsWith(prefix))?.[1];
      const exitCode = line.startsWith('npm test') ? (testExitCodes.shift() ?? 0) : (other?.shift() ?? 0);
      return { command: line, exitCode, stdout: exitCode === 0 ? 'ok' : 'not ok 1 - cộng sai', stderr: '' };
    },
  };
  const gateway = {
    async generate(request: { messages: Array<{ content: string }> }) {
      requests.push(request.messages.map((message) => message.content).join('\n'));
      const text = replies[Math.min(calls, replies.length - 1)]!;
      calls += 1;
      if (calls === options.abortAfterCalls) controller.abort();
      return { text, provider: 'test', model: 'test', costUsd: 0.01, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    },
  };
  const context = {
    runId: 'r1',
    agentId: 'a1',
    projectId: 'p1',
    taskId,
    project: null,
    task: { id: taskId, title: 'Viết', description: '', fixLoopCount: options.fixLoopCount ?? 0 },
    events: { async publish(_type: string, payload: { pct: number; text: string }) { progress.push({ pct: payload.pct, text: payload.text }); } },
    gateway,
    sandbox,
    history: [],
    priorWork: options.priorWork ?? [],
    documents: options.documents ?? [],
    allowedRoles: [],
    knowledge: [],
    signal: controller.signal,
  } as unknown as AgentContext;
  return { context, written, execs, requests, progress, calls: () => calls };
}

const plan = (summary: string, paths: string[]) =>
  JSON.stringify({ summary, files: paths.map((path) => ({ path, purpose: 'x' })), testCommand: 'npm test' });
const reply = (summary: string, files: Array<{ path: string; content: string }>) =>
  JSON.stringify({ summary, files, testCommand: 'npm test' });

const PKG = { path: 'package.json', content: '{"scripts":{"test":"node --test"}}' };

describe('DeveloperAgent tự kiểm', () => {
  it('lập danh sách tệp, viết, chạy npm test; xanh thì báo xanh, không hỏi sửa', async () => {
    const fake = fakeContext([plan('viết engine', ['package.json', 'src/a.js']), reply('viết', [PKG, { path: 'src/a.js', content: '1' }])], [0]);
    const outcome = await new DeveloperAgent('BACKEND_DEVELOPER').run(fake.context);

    expect(outcome.status).toBe('completed');
    expect(fake.execs).toEqual(['npm install --no-audit --no-fund --dangerously-allow-all-scripts', 'npm test --silent']);
    expect(fake.calls()).toBe(2);
    expect(outcome.summary).toContain('xanh');
    expect(fake.requests[0]).toContain('lập danh sách tệp');
    expect(fake.requests[1]).toContain('- package.json');
  });

  it('chưa liệt kê tệp vì còn câu hỏi thì gửi câu hỏi, không coi là trả sai khuôn', async () => {
    const asking = JSON.stringify({
      summary: 'cần chốt trước',
      files: [],
      questions: [{ question: 'Lưu tiến độ theo từng hồ sơ hay chung?', options: ['từng hồ sơ', 'chung'], recommended: 0 }],
    });
    const fake = fakeContext([asking], [0]);
    const outcome = await new DeveloperAgent('BACKEND_DEVELOPER').run(fake.context);
    expect(outcome.status).toBe('completed');
    expect(outcome.questions).toHaveLength(1);
    expect(fake.calls()).toBe(1);
  });

  it('test đỏ thì được sửa đúng một lần với output thật rồi chạy lại', async () => {
    const fake = fakeContext(
      [
        plan('viết engine', ['package.json', 'src/a.js']),
        reply('viết', [PKG, { path: 'src/a.js', content: 'sai' }]),
        reply('sửa phép cộng', [{ path: 'src/a.js', content: 'đúng' }]),
      ],
      [1, 0],
    );
    const outcome = await new DeveloperAgent('BACKEND_DEVELOPER').run(fake.context);

    expect(fake.calls()).toBe(3);
    expect(fake.written.get('src/a.js')).toBe('đúng');
    expect(outcome.summary).toContain('đã sửa: sửa phép cộng');
    expect(outcome.summary).toContain('xanh');
    expect(outcome.producedFiles?.map((file) => file.path).sort()).toEqual(['package.json', 'src/a.js']);
    expect(outcome.costUsd).toBeCloseTo(0.03);
  });

  it('vẫn đỏ sau khi sửa thì nói thẳng trong tóm tắt, không giả vờ xong', async () => {
    const fake = fakeContext(
      [plan('viết', ['package.json']), reply('viết', [PKG]), reply('sửa', [{ path: 'src/a.js', content: 'vẫn sai' }])],
      [1, 1, 1],
    );
    const outcome = await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);
    // Được sửa tối đa hai vòng rồi mới giao, còn đỏ thì nói thẳng.
    expect(fake.calls()).toBe(4);
    expect(outcome.summary).toContain('vẫn đỏ');
    expect(outcome.summary).toContain('cộng sai');
  });

  it('test xanh nhưng biên dịch hỏng thì cũng phải sửa trước khi giao (preload gọi kiểu đã bị xoá)', async () => {
    const pkg = { path: 'package.json', content: '{"scripts":{"test":"node --test","typecheck":"tsc --noEmit","build":"tsc && electron-builder --win"}}' };
    const fake = fakeContext(
      [
        plan('sửa kiểu dùng chung', ['package.json', 'src/shared/types.ts']),
        reply('viết', [pkg, { path: 'src/shared/types.ts', content: 'export type VersionInfo = string;' }]),
        reply('giữ tên cũ cho preload', [{ path: 'src/shared/types.ts', content: 'export type AppVersionInfo = string;' }]),
      ],
      [0, 0],
      { commandExits: { 'npm run typecheck': [2, 0] } },
    );
    const outcome = await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);

    expect(fake.execs.filter((line) => line.startsWith('npm run typecheck'))).toHaveLength(2);
    // Không chạy bước đóng gói .exe khi tự kiểm — quá lâu; QA và bước dựng lo phần đó.
    expect(fake.execs.some((line) => line.includes('run build'))).toBe(false);
    expect(fake.requests[2]).toContain('npm run typecheck');
    expect(fake.written.get('src/shared/types.ts')).toContain('AppVersionInfo');
    expect(outcome.summary).toContain('xanh');
  });

  it('vòng sửa thấy đoạn mã quanh dòng lỗi (đánh số dòng), không phải đoán rồi viết lại cả tầng', async () => {
    const pkg = { path: 'package.json', content: '{"scripts":{"test":"node --test","typecheck":"tsc --noEmit"}}' };
    const app = Array.from({ length: 150 }, (_, i) => (i === 108 ? '  return findProfile(state.progress, state.profileId);' : `// dòng ${i + 1}`)).join('\n');
    const fake = fakeContext(
      [
        plan('sửa', ['package.json', 'src/renderer/app.ts']),
        reply('viết', [pkg, { path: 'src/renderer/app.ts', content: app }]),
        reply('thêm ?? null', [{ path: 'src/renderer/app.ts', content: app.replace('state.profileId);', 'state.profileId) ?? null;') }]),
      ],
      [0, 0],
      { commandExits: { 'npm run typecheck': [2, 0] } },
    );
    const baseExec = fake.context.sandbox!.exec.bind(fake.context.sandbox);
    (fake.context.sandbox as { exec: typeof baseExec }).exec = async (command, args = []) => {
      const result = await baseExec(command, args);
      if (result.exitCode === 2) {
        return { ...result, stdout: "\u001b[96msrc/renderer/app.ts\u001b[0m:\u001b[93m109\u001b[0m:3 - error TS2322: Type 'ProfileView | undefined' is not assignable" };
      }
      return result;
    };
    await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);

    const fixPrompt = fake.requests[2]!;
    expect(fixPrompt).toContain('109|   return findProfile(state.progress, state.profileId);');
    expect(fixPrompt).toContain('src/renderer/app.ts:109:3');
    expect(fixPrompt).not.toContain('\u001b[');
    expect(fixPrompt).not.toContain('// dòng 20\n');
  });

  it('không có package.json thì không chạy test và nói rõ', async () => {
    const fake = fakeContext([plan('viết html', ['index.html']), reply('viết html', [{ path: 'index.html', content: '<p>' }])], []);
    const outcome = await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);
    expect(fake.execs).toEqual([]);
    expect(outcome.summary).toContain('chưa chạy được test');
  });

  it('thấy nội dung file đang có và kết quả bước trước, được dặn sửa chứ không viết lại', async () => {
    const fake = fakeContext(
      [plan('thêm phím %', ['src/app.ts']), reply('thêm phím %', [{ path: 'src/app.ts', content: 'x' }])],
      [],
      {
        files: { 'index.html': '<main class="calc"><h1>Máy tính</h1></main>', 'src/styles.css': '.calc{--accent:#2563eb}' },
        priorWork: [{ role: 'UIUX_DESIGNER', title: 'Thiết kế UI', summary: 'Phím tròn, màu xanh 2563eb' }],
      },
    );
    await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);

    const prompt = fake.requests[0]!;
    expect(prompt).toContain('NỘI DUNG FILE ĐANG CÓ');
    expect(prompt).toContain('<main class="calc">');
    expect(prompt).toContain('.calc{--accent:#2563eb}');
    expect(prompt).toContain('KẾT QUẢ CÁC BƯỚC TRƯỚC');
    expect(prompt).toContain('Phím tròn, màu xanh 2563eb');
    expect(prompt).toContain('không viết lại từ đầu');
  });

  it('đọc NGUYÊN VĂN tài liệu thiết kế và sổ quyết định, không chỉ tóm tắt 1500 ký tự', async () => {
    const spec = '# Thiết kế giao diện\n' + 'Màu nhấn #4b4fb8 cho ngủ đông. '.repeat(80) + '\nCHI TIẾT CUỐI: nút Hủy màu #c4552a.';
    const fake = fakeContext([plan('dựng', ['src/app.ts']), reply('dựng', [{ path: 'src/app.ts', content: 'x' }])], [], {
      documents: [
        { path: 'docs/thiet-ke.md', title: 'Thiết kế giao diện (Phòng thiết kế)', content: spec },
        { path: 'docs/quyet-dinh.md', title: 'Sổ quyết định (Phòng điều hành)', content: '- Dùng ngủ đông để tự bật lại máy.' },
      ],
    });
    await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);

    const prompt = fake.requests[0]!;
    expect(prompt).toContain('TÀI LIỆU DỰ ÁN');
    expect(prompt).toContain('CHI TIẾT CUỐI: nút Hủy màu #c4552a.');
    expect(prompt).toContain('Dùng ngủ đông để tự bật lại máy.');
  });
});

describe('DeveloperAgent viết theo lô', () => {
  const eight = ['package.json', 'src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js', 'src/f.js', 'tests/a.test.js'];

  it('8 tệp → hai lô (4 + 4); lô sau thấy tệp đã viết; tiến độ tăng dần tới 100', async () => {
    const fake = fakeContext(
      [
        plan('máy tính', eight),
        reply('lô 1', eight.slice(0, 4).map((path) => ({ path, content: path === 'package.json' ? PKG.content : `// ${path}` }))),
        reply('lô 2', eight.slice(4).map((path) => ({ path, content: `// ${path}` }))),
      ],
      [0],
    );
    const outcome = await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);

    expect(fake.calls()).toBe(3);
    // Lô 1 chỉ xin 4 tệp đầu; src/d.js trở đi nằm ở lô 2.
    expect(fake.requests[1]).toMatch(/không thêm tệp khác:\n(?:- .*\n)*- src\/c\.js/);
    expect(fake.requests[1]).not.toMatch(/không thêm tệp khác:\n(?:- .*\n)*- src\/d\.js/);
    expect(fake.requests[2]).toMatch(/không thêm tệp khác:\n- src\/d\.js/);
    expect(fake.requests[2]).toContain('TỆP ĐÃ VIẾT XONG');
    expect(fake.requests[2]).toContain('--- src/a.js ---');
    expect(outcome.producedFiles).toHaveLength(8);
    const pcts = fake.progress.map((item) => item.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    expect(pcts.at(-1)).toBe(100);
    expect(fake.progress.some((item) => item.text === 'Đã viết 4/8 tệp')).toBe(true);
    // Xong thì tiến độ được dọn để vòng sửa sau lập kế hoạch lại.
    expect(fake.written.get('.pn/tien-do/t1.json')).toBe('{}');
  });

  it('lô trả lời không ra JSON (bị cắt vì dài) thì thu còn một nửa rồi hỏi lại, không chặn task', async () => {
    const four = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'];
    const fake = fakeContext(
      [
        plan('bốn tệp', four),
        'Tôi sẽ viết... (bị cắt',
        'vẫn không phải json',
        reply('nửa đầu', four.slice(0, 2).map((path) => ({ path, content: 'x' }))),
        reply('nửa sau', four.slice(2).map((path) => ({ path, content: 'y' }))),
      ],
      [],
    );
    const outcome = await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);
    // 1 kế hoạch + 2 (lô 4 tệp hỏng cả lượt sửa) + 1 (2 tệp) + 1 (2 tệp còn lại).
    expect(fake.calls()).toBe(5);
    expect(fake.requests[3]).toMatch(/không thêm tệp khác:\n- src\/a\.js: x\n- src\/b\.js: x\npackage/);
    expect(outcome.producedFiles?.map((file) => file.path)).toEqual(four);
  });

  it('lượt trước bị cắt sau lô 1: lượt này không lập kế hoạch lại, chỉ viết tệp còn thiếu', async () => {
    const saved = JSON.stringify({
      taskId: 't1',
      fixLoopCount: 0,
      plan: { summary: 'máy tính', files: eight.map((path) => ({ path, purpose: 'x' })), testCommand: 'npm test' },
      done: eight.slice(0, 6),
    });
    const fake = fakeContext([reply('lô 2', eight.slice(6).map((path) => ({ path, content: `// ${path}` })))], [0], {
      files: { '.pn/tien-do/t1.json': saved, 'package.json': PKG.content, 'src/a.js': '// a' },
    });
    const outcome = await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);

    expect(fake.calls()).toBe(1);
    expect(fake.requests[0]).toMatch(/không thêm tệp khác:\n- src\/f\.js/);
    expect(fake.requests[0]).not.toContain('lập danh sách tệp');
    expect(fake.progress[0]).toMatchObject({ text: 'Viết tiếp 2 tệp còn thiếu' });
    expect(outcome.summary).toContain('xanh');
  });

  it('tiến độ của vòng sửa cũ (fixLoopCount khác) thì bỏ, lập kế hoạch mới', async () => {
    const saved = JSON.stringify({ taskId: 't1', fixLoopCount: 0, plan: { summary: 'cũ', files: [{ path: 'src/a.js', purpose: 'x' }], testCommand: null }, done: [] });
    const fake = fakeContext([plan('sửa lỗi', ['src/a.js']), reply('sửa', [{ path: 'src/a.js', content: 'mới' }])], [], {
      files: { '.pn/tien-do/t1.json': saved },
      fixLoopCount: 1,
    });
    await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);
    expect(fake.calls()).toBe(2);
    expect(fake.requests[0]).toContain('lập danh sách tệp');
  });

  it('hết giờ sau lô 1 thì dừng ngay: không gọi thêm model, không chạy test, tiến độ lô 1 đã lưu', async () => {
    const fake = fakeContext(
      [plan('máy tính', eight), reply('lô 1', eight.slice(0, 4).map((path) => ({ path, content: `// ${path}` })))],
      [0],
      { abortAfterCalls: 2 },
    );
    await expect(new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context)).rejects.toThrow(/Hết giờ/);

    expect(fake.calls()).toBe(2);
    expect(fake.execs).toEqual([]);
    const saved = JSON.parse(fake.written.get('.pn/tien-do/t1.json')!) as { done: string[] };
    expect(saved.done).toEqual(eight.slice(0, 4));
  });

  it('mỗi việc một file tiến độ: việc Backend không đọc cũng không đè tiến độ dở của Frontend', async () => {
    const frontend = JSON.stringify({
      taskId: 't1',
      fixLoopCount: 0,
      plan: { summary: 'giao diện', files: eight.map((path) => ({ path, purpose: 'x' })), testCommand: null },
      done: eight.slice(0, 4),
    });
    const fake = fakeContext([plan('lõi', ['src/core.js']), reply('lõi', [{ path: 'src/core.js', content: '1' }])], [], {
      taskId: 't2',
      files: { '.pn/tien-do/t1.json': frontend },
    });
    await new DeveloperAgent('BACKEND_DEVELOPER').run(fake.context);

    expect(fake.requests[0]).toContain('lập danh sách tệp');
    expect(fake.written.get('.pn/tien-do/t1.json')).toBe(frontend);
    expect(fake.written.get('.pn/tien-do/t2.json')).toBe('{}');
  });

  it('mô hình quên một tệp trong lô thì lô sau hỏi lại tệp đó, không lặp vô hạn', async () => {
    const fake = fakeContext(
      [
        plan('hai tệp', ['src/a.js', 'src/b.js']),
        reply('chỉ a', [{ path: 'src/a.js', content: 'a' }]),
        reply('b', [{ path: 'src/b.js', content: 'b' }]),
      ],
      [],
    );
    const outcome = await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);
    expect(fake.calls()).toBe(3);
    expect(fake.requests[2]).toContain('- src/b.js');
    expect(fake.requests[2]).not.toMatch(/không thêm tệp khác:\n- src\/a\.js/);
    expect(outcome.producedFiles?.map((file) => file.path)).toEqual(['src/a.js', 'src/b.js']);
  });
});

describe('chuẩn kỹ thuật theo loại sản phẩm', () => {
  it('dự án desktop thì dev được dặn Electron + electron-builder ra .exe', async () => {
    const fake = fakeContext([plan('viết', ['src/main.ts']), reply('viết', [{ path: 'src/main.ts', content: 'x' }])], []);
    (fake.context as { project: unknown }).project = {
      id: 'p', name: 'Ghi chú', description: 'exe', productType: 'DESKTOP_APPLICATION', repoFullName: null, defaultBranch: 'main',
    };
    await new DeveloperAgent('FRONTEND_DEVELOPER').run(fake.context);
    expect(fake.requests[0]).toContain('Electron');
    expect(fake.requests[0]).toContain('electron-builder --win portable');
  });
});

describe('keyFileContents', () => {
  it('chỉ lấy file định hình sản phẩm, cắt bớt file dài', async () => {
    const files: Record<string, string> = {
      'index.html': '<p>trang</p>',
      'package.json': '{}',
      'src/styles.css': 'a'.repeat(50),
      'src/main.ts': 'boot()',
      'src/calc.ts': 'engine',
      'tests/x.test.js': 't',
      'node_modules/x/index.js': 'no',
    };
    const text = await keyFileContents({ async readFile(path: string) { return files[path]!; } }, Object.keys(files), {
      perFile: 20,
      total: 24000,
      count: 8,
    });
    expect(text).toContain('--- index.html ---');
    expect(text).toContain('--- src/main.ts ---');
    expect(text).toContain('…[cắt bớt]');
    expect(text).not.toContain('src/calc.ts');
    expect(text).not.toContain('node_modules');
  });
});

describe('mergePackageJson', () => {
  const sandboxWith = (existing: string | null) => ({
    async readFile() {
      if (existing === null) throw new Error('không có');
      return existing;
    },
  });

  it('giữ scripts và devDependencies của bản cũ, bản mới ghi đè khoá trùng', async () => {
    const merged = JSON.parse(
      await mergePackageJson(
        sandboxWith(
          JSON.stringify({
            name: 'app',
            scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' },
            devDependencies: { vite: '^5', vitest: '^1' },
          }),
        ),
        JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test tests/' } }),
      ),
    ) as { type: string; scripts: Record<string, string>; devDependencies: Record<string, string> };

    expect(merged.type).toBe('module');
    expect(merged.scripts).toEqual({ dev: 'vite', build: 'vite build', test: 'node --test tests/' });
    expect(merged.devDependencies).toEqual({ vite: '^5', vitest: '^1' });
  });

  it('chưa có file cũ, hoặc JSON hỏng, thì lấy nguyên bản mới', async () => {
    expect(await mergePackageJson(sandboxWith(null), '{"a":1}')).toBe('{"a":1}');
    expect(await mergePackageJson(sandboxWith('không phải json'), '{"a":1}')).toBe('{"a":1}');
  });
});
