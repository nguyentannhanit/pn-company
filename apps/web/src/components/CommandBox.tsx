/**
 * P&N — Ô lệnh trên cùng: vừa đi nhanh, vừa ra lệnh.
 *
 * Trước đây ô này chỉ khớp tên trang ("Chi phí" → tab Chi phí). Giờ gõ tới đâu
 * gợi ý tới đó: trang, phòng (lướt camera tới phòng trong 3D), người, dự án, và
 * lệnh — "chạy lại việc kẹt", hoặc câu bất kỳ thì hỏi trợ lý Khang. Ctrl+K để gõ.
 */

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AGENT_PROFILES } from '@pn/shared';

import { api, type ProjectRow } from '@/lib/api';
import { openAssistant } from '@/lib/assistant';
import { DEPARTMENT_LABEL } from '@/lib/brand';
import { rerunTask, type BlockedItem } from '@/lib/insights';

interface Suggestion {
  id: string;
  /** Nhóm hiện bên phải: Trang, Phòng, Người, Dự án, Lệnh. */
  group: string;
  label: string;
  run: () => void | Promise<void>;
}

/** So khớp không dấu, không phân biệt hoa thường: gõ "chi phi" vẫn ra "Chi phí". */
const plain = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

export function CommandBox({ pages }: { pages: Array<{ href: string; label: string }> }): React.JSX.Element {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // Ctrl+K (hoặc ⌘K) ở bất kỳ đâu để gõ lệnh.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Tên dự án chỉ tải khi người dùng bắt đầu gõ, không tốn một lượt gọi mỗi lần mở trang.
  useEffect(() => {
    if (!open || projects.length > 0) return;
    api<{ projects: ProjectRow[] }>('/projects')
      .then((result) => setProjects(result.projects.filter((project) => project.status !== 'ARCHIVED')))
      .catch(() => undefined);
  }, [open, projects.length]);

  const suggestions = useMemo<Suggestion[]>(() => {
    const text = query.trim();
    const q = plain(text);
    if (!q) return [];
    const go = (href: string) => () => router.push(href);
    const people = Object.entries(AGENT_PROFILES as Record<string, { displayName: string; department: string }>);
    const list: Suggestion[] = [
      ...pages.filter((page) => plain(page.label).includes(q)).map((page) => ({ id: page.href, group: 'Trang', label: page.label, run: go(page.href) })),
      ...Object.entries(DEPARTMENT_LABEL)
        .filter(([, label]) => plain(label).includes(q))
        .flatMap(([department, label]) => {
          // Lướt tới phòng = lướt tới bàn người đầu tiên của phòng đó (thẻ phòng mở theo).
          const first = people.find(([, profile]) => profile.department === department)?.[0];
          return first ? [{ id: `room-${department}`, group: 'Phòng', label: `Tới ${label} trong 3D`, run: go(`/overview?nguoi=${first}`) }] : [];
        }),
      ...people
        .filter(([, profile]) => plain(profile.displayName).includes(q))
        .map(([role, profile]) => ({ id: `person-${role}`, group: 'Người', label: `${profile.displayName} — xem trong 3D`, run: go(`/overview?nguoi=${role}`) })),
      ...projects
        .filter((project) => plain(project.name).includes(q))
        .map((project) => ({ id: `project-${project.id}`, group: 'Dự án', label: project.name, run: go(`/projects/${project.id}`) })),
    ];
    if ('chay lai viec ket'.includes(q) || q.includes('ket') || q.includes('chay lai')) {
      list.push({
        id: 'rerun-blocked',
        group: 'Lệnh',
        label: 'Chạy lại mọi việc đang kẹt',
        run: async () => {
          setNotice('Đang chạy lại việc kẹt…');
          const { items } = await api<{ items: BlockedItem[] }>('/insights/blocked');
          let ok = 0;
          // Lần lượt từng việc: chạy song song dễ làm gói miễn phí hết lượt.
          for (const item of items) if ((await rerunTask(item.taskId)).ok) ok += 1;
          setNotice(items.length === 0 ? 'Không có việc nào đang kẹt.' : `Đã chạy lại ${items.length} việc — ${ok} việc chạy được.`);
        },
      });
    }
    // Câu nào cũng hỏi được trợ lý; đặt cuối để lối tắt chính xác đứng trước.
    list.push({ id: 'ask', group: 'Hỏi Khang', label: `“${text}”`, run: () => openAssistant(text) });
    return list.slice(0, 8);
  }, [query, pages, projects, router]);

  const choose = (suggestion: Suggestion | undefined): void => {
    if (!suggestion) return;
    setQuery('');
    setOpen(false);
    input.current?.blur();
    void suggestion.run();
  };

  return (
    <div className="pn-command relative hidden w-full max-w-[440px] md:block">
      <label className="group flex h-10 items-center gap-3 rounded-xl border border-line bg-fill-1 px-3.5 text-ink-500 transition-colors focus-within:border-brand-400/50">
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={input}
          value={query}
          type="search"
          name="pn-command"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          onChange={(event) => {
            // Chrome tự điền email đã lưu vào ô này ngay sau khi đăng nhập — lúc đó ô chưa được chọn.
            // Người gõ thật thì ô luôn đang được chọn, nên giá trị đến khi ô không được chọn là tự điền: bỏ qua.
            if (document.activeElement !== event.currentTarget) {
              setQuery('');
              return;
            }
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
            setNotice(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, suggestions.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(suggestions[active]);
            } else if (event.key === 'Escape') {
              setQuery('');
              input.current?.blur();
            }
          }}
          placeholder="Đi tới hoặc ra lệnh: phòng, người, dự án, “chạy lại việc kẹt”…"
          aria-label="Ô lệnh: đi nhanh tới một mục hoặc ra lệnh"
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls="pn-command-list"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-500"
        />
        <kbd className="hidden rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-500 lg:inline">Ctrl K</kbd>
      </label>
      {open && suggestions.length > 0 && (
        <ul id="pn-command-list" role="listbox" className="pn-command-list">
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.id}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(suggestion)}
            >
              <span className="truncate">{suggestion.label}</span>
              <small>{suggestion.group}</small>
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="pn-command-notice">{notice}</p>}
    </div>
  );
}
