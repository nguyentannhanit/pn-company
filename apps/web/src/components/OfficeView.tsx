/**
 * P&N — Khung chứa văn phòng: 3D khi máy chạy được, sơ đồ 2D khi không (§32).
 *
 * §32 yêu cầu có bản 2D thay thế. Ở đây nó không phải "màn hình lỗi" mà là một
 * cách xem khác của cùng dữ liệu: cùng phòng ban, cùng trạng thái, cùng ý nghĩa
 * màu sắc. Người dùng cũng chủ động chuyển được, vì trên máy yếu hoặc khi cần
 * đọc nhanh thì sơ đồ phẳng lại tiện hơn.
 */

'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

import { OrgFlow2D } from '@/components/OrgFlow2D';
import type { AgentRow } from '@/lib/api';
import { OFFICE_GENERAL_LINES, officeLine } from '@pn/shared';

import { officeAudio, type OfficeSfx } from '@/lib/office-audio';
import { officeVoice } from '@/lib/office-voice';
import { useRealtime } from '@/lib/store';

// Three.js chỉ chạy ở trình duyệt và nặng, nên tải động và không dựng ở server.
const Office = dynamic(() => import('@/three/Office').then((module) => module.Office), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-[#c2d0d5] text-sm text-[#354e5f]">
      <span className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] px-4 py-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-brand-400 pn-pulse" />
        Đang dựng văn phòng…
      </span>
    </div>
  ),
});

/** Kiểm tra WebGL thật sự dùng được, thay vì đoán qua user agent. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function OfficeView({
  agents,
  onSelect,
  live = true,
  calm: motionOverride,
  focusRole = null,
}: {
  agents: AgentRow[];
  onSelect: (role: string) => void;
  live?: boolean;
  calm?: boolean;
  /** Mở với camera ở bàn người này. */
  focusRole?: string | null;
}): React.JSX.Element {
  const [mode, setMode] = useState<'checking' | '3d' | '2d'>('checking');
  const [motion, setMotion] = useState(true);
  const [voice, setVoice] = useState(false);

  useEffect(() => {
    // Chỉ WebGL quyết định xem có dựng được 3D hay không.
    setMode(webglAvailable() ? '3d' : '2d');
    // Chuyển động là NỘI DUNG của văn phòng (ai đang gõ, ai đang đi giao việc),
    // không phải trang trí, nên không để tuỳ chọn "giảm chuyển động" của hệ điều
    // hành âm thầm đóng băng nó nữa: Windows của CEO tắt hiệu ứng động, và ba
    // phiên liền CEO thấy "3D bất động" dù dữ liệu tới đủ. Ai muốn yên tĩnh thì
    // bấm nút tắt, lựa chọn được nhớ ở máy đó.
    try {
      setMotion(localStorage.getItem('pn.office.motion') !== 'off');
    } catch {
      // Trình duyệt chặn lưu trữ thì mặc định bật.
    }
  }, []);

  // Giọng nói, nhạc nền và hiệu ứng mặc định bật, trừ máy đã bấm tắt. Trình duyệt chỉ cho phát sau cú
  // chạm nên đợi cú chạm đầu tiên trên trang rồi mới bật — bấm nút cũng là một cú chạm. Rời văn phòng thì nhạc tắt dần.
  useEffect(() => {
    officeAudio.enterOffice();
    const arm = (): void => {
      if (officeVoice.remembered()) {
        officeVoice.enable();
        setVoice(true);
      }
    };
    window.addEventListener('pointerdown', arm, { once: true });
    return () => {
      window.removeEventListener('pointerdown', arm);
      officeAudio.leaveOffice();
    };
  }, []);

  // Nhạc sôi theo số người đang làm thật (6 người trở lên là mức cao nhất).
  const busy = agents.filter((agent) => agent.state === 'working' || agent.state === 'reviewing' || agent.state === 'meeting').length;
  useEffect(() => officeAudio.setIntensity(busy / 6), [busy]);

  // Việc chuyển giao thật (người đưa việc lên đường / chấm sáng trên sơ đồ) → tiếng "vút".
  const handoffCount = useRealtime((state) => state.handoffs.length);
  const handoffsBefore = useRef(handoffCount);
  useEffect(() => {
    if (handoffCount > handoffsBefore.current) officeAudio.play('handoff');
    handoffsBefore.current = handoffCount;
  }, [handoffCount]);

  // Tiếng bấm nút / nhãn phòng do `ClickSounds` (toàn app) lo. Bấm nhân viên (3D hay sơ đồ) → tiếng mở bảng.
  const select = (role: string): void => {
    officeAudio.play('open');
    onSelect(role);
  };

  // Đọc trạng thái thật từ officeVoice chứ không từ state: cú chạm đầu tiên có thể vừa bật xong ngay trước cú bấm này.
  const toggleVoice = (): void => {
    if (officeVoice.enabled) officeVoice.disable();
    else officeVoice.enable();
    setVoice(officeVoice.enabled);
  };

  // Khang đọc theo trạng thái thật (thêm "bắt đầu" và "báo lỗi" cho đỡ im lặng): phòng bắt đầu làm, xong
  // việc, kẹt hay báo lỗi thì báo bằng tiếng Việt, gọi đúng tên phòng. Câu lấy từ `@pn/shared` — API đã đọc sẵn đúng
  // những câu này bằng Vbee nên phát ngay.
  const previous = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const before = previous.current;
    for (const agent of agents) {
      const was = before.get(agent.role);
      if (was === undefined || was === agent.state) continue;
      const event =
        agent.state === 'completed' || agent.state === 'celebrate' ? 'done'
        : agent.state === 'blocked' ? 'blocked'
        : agent.state === 'alert' ? 'alert'
        : agent.state === 'working' && was === 'idle' ? 'started'
        : null;
      const line = event ? officeLine(event, agent.department) : null;
      if (line) officeVoice.say(line);
      const sound: Record<string, OfficeSfx> = { done: 'done', blocked: 'alert', alert: 'alert', started: 'start' };
      if (event) officeAudio.play(sound[event]!);
    }
    previous.current = new Map(agents.map((agent) => [agent.role, agent.state]));
  }, [agents]);

  // Có thêm phiếu chờ CEO duyệt thì báo một câu.
  const pendingApprovals = useRealtime((state) => state.pendingApprovals);
  const approvalsBefore = useRef<number | null>(null);
  useEffect(() => {
    if (approvalsBefore.current !== null && pendingApprovals > approvalsBefore.current) {
      officeAudio.play('notify');
      officeVoice.say(OFFICE_GENERAL_LINES.approval);
    }
    approvalsBefore.current = pendingApprovals;
  }, [pendingApprovals]);

  const toggleMotion = (): void => {
    const next = !motion;
    setMotion(next);
    try {
      localStorage.setItem('pn.office.motion', next ? 'on' : 'off');
    } catch {
      // Không lưu được thì chỉ áp dụng cho phiên này.
    }
  };

  return (
    <div className="relative h-full w-full">
      {mode === '3d' ? <Office agents={agents} onSelect={select} calm={motionOverride ?? !motion} live={live} focusRole={focusRole} /> : null}
      {mode === '2d' ? <OrgFlow2D agents={agents} onSelect={select} /> : null}

      {mode !== 'checking' && (
        <div className="absolute right-3 top-3 z-20 flex flex-col items-end gap-1.5 sm:right-5 sm:top-5 sm:flex-row sm:items-center sm:gap-2">
          {motionOverride === undefined && <SoundMenu voice={voice} onToggleVoice={toggleVoice} />}
          {mode === '3d' && motionOverride === undefined && (
            <button
              onClick={toggleMotion}
              title="Nhân vật gõ phím, đi lại khi có việc thật. Tắt nếu muốn màn hình đứng yên."
              className="office-mode rounded-xl px-3 py-2 text-[10px] font-medium"
            >
              {motion ? 'Chuyển động: bật' : 'Chuyển động: tắt'}
            </button>
          )}
          <button
            onClick={() => setMode(mode === '3d' ? '2d' : '3d')}
            className="office-mode rounded-xl px-3 py-2 text-[10px] font-medium"
          >
            {mode === '3d' ? 'Xem sơ đồ 2D' : 'Xem văn phòng 3D'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Nút "Âm thanh" kiểu bảng cài đặt trong game: giọng Khang, nhạc nền, hiệu ứng — bật/tắt và âm lượng từng thứ.
 * Gộp ba thứ vào một nút để góc văn phòng không thêm hai nút nữa (điện thoại vốn đã chật).
 */
function SoundMenu({ voice, onToggleVoice }: { voice: boolean; onToggleVoice: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(officeAudio.prefs);
  const [, setServerKnown] = useState(false);
  useEffect(() => officeAudio.subscribe(() => setPrefs({ ...officeAudio.prefs })), []);
  // Mở menu thì hỏi máy chủ Vbee đã nối chưa — không thì dòng Giọng Khang báo nhầm "máy chưa có giọng tiếng Việt".
  useEffect(() => {
    if (open) void officeVoice.checkServer().then(() => setServerKnown(true));
  }, [open]);
  const on = [voice, prefs.music, prefs.sfx].filter(Boolean).length;

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="office-mode rounded-xl px-3 py-2 text-[10px] font-medium"
        title="Giọng Khang, nhạc nền và hiệu ứng âm thanh"
      >
        {on === 0 ? 'Âm thanh: tắt' : `Âm thanh: ${on}/3`}
      </button>
      {open && (
        <div className="office-sound-menu" role="dialog" aria-label="Âm thanh văn phòng">
          <SoundRow
            label="Giọng Khang"
            hint={
              officeVoice.missingVoice
                ? 'Máy chưa có giọng tiếng Việt — nối Vbee ở Cài đặt → Tích hợp'
                : `${officeVoice.usesVbee ? 'Giọng Vbee' : 'Giọng trong máy'}; báo khi phòng bắt đầu, xong, kẹt, có phiếu duyệt`
            }
            on={voice}
            onToggle={onToggleVoice}
          />
          <SoundRow
            label="Nhạc nền"
            hint="Tự soạn, sôi dần theo số người đang làm"
            on={prefs.music}
            onToggle={() => officeAudio.update({ music: !prefs.music })}
            volume={prefs.musicVolume}
            onVolume={(value) => officeAudio.update({ musicVolume: value })}
          />
          <SoundRow
            label="Hiệu ứng"
            hint="Mọi cú bấm trong công ty, lưu/lỗi, chuyển giao việc, xong việc"
            on={prefs.sfx}
            onToggle={() => officeAudio.update({ sfx: !prefs.sfx })}
            volume={prefs.sfxVolume}
            onVolume={(value) => officeAudio.update({ sfxVolume: value })}
          />
        </div>
      )}
    </div>
  );
}

function SoundRow({ label, hint, on, onToggle, volume, onVolume }: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
  volume?: number;
  onVolume?: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="office-sound-row">
      <div className="office-sound-head">
        <span>
          <b>{label}</b>
          <small>{hint}</small>
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onToggle} className={`office-sound-switch${on ? ' is-on' : ''}`}>
          <i />
        </button>
      </div>
      {onVolume && volume !== undefined && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          disabled={!on}
          aria-label={`Âm lượng ${label.toLowerCase()}`}
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      )}
    </div>
  );
}
