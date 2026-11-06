/**
 * P&N — Khang đọc thông báo bằng tiếng Việt ("âm thanh phải là tiếng nói,
 * không phải tiếng động vô nghĩa").
 *
 * Hai nguồn giọng (giọng máy của trình duyệt nghe "đơ"):
 *   - Giọng Vbee qua API P&N (`/voice/speak`) khi đã nối ở Cài đặt → Tích hợp → Giọng nói. Trình duyệt không cầm
 *     token Vbee; API đệm câu lặp và giữ trần ký tự tháng.
 *   - Giọng có sẵn trong máy (Web Speech API) làm dự phòng: chưa nối Vbee, Vbee lỗi, hết hạn mức hay hết credit thì
 *     câu đó đọc bằng giọng máy. iPhone/Mac có sẵn giọng tiếng Việt; Windows phải cài gói "Tiếng Việt → Giọng nói".
 *     Không có giọng Việt thì im (đọc bằng giọng Anh còn tệ hơn), và `missingVoice` để nút hiện lý do.
 *
 * Trình duyệt chỉ cho phát sau một cú chạm nên mặc định TẮT; bật bằng nút và nhớ ở máy
 * (`pn.office.voice`). Đang tắt thì `say` không làm gì — gọi thoải mái.
 */

import { OFFICE_GENERAL_LINES } from '@pn/shared';

import { apiUrl, getToken } from '@/lib/api';
import { officeAudio } from '@/lib/office-audio';

const KEY = 'pn.office.voice';

class OfficeVoice {
  #enabled = false;
  #voice: SpeechSynthesisVoice | null | undefined;
  /** Vbee có dùng được không: null = chưa hỏi API. */
  #server: boolean | null = null;
  /** Các câu đọc bằng Vbee nối đuôi nhau, không chen ngang. */
  #queue: Promise<void> = Promise.resolve();

  get enabled(): boolean {
    return this.#enabled;
  }

  get supported(): boolean {
    return typeof window !== 'undefined' && ('speechSynthesis' in window || typeof Audio !== 'undefined');
  }

  /** Đang đọc bằng giọng Vbee (đã nối ở Tích hợp) hay giọng có sẵn trong máy. */
  get usesVbee(): boolean {
    return this.#server === true;
  }

  /** Không có giọng nào đọc được tiếng Việt: chưa nối Vbee và máy cũng không có giọng Việt. */
  get missingVoice(): boolean {
    return this.#server !== true && this.#local() === null;
  }

  /** Lựa chọn đã nhớ ở máy; chưa chọn bao giờ thì BẬT ("đỡ bị im lặng") — chỉ tắt khi anh đã bấm tắt. */
  remembered(): boolean {
    try {
      return localStorage.getItem(KEY) !== 'off';
    } catch {
      return true;
    }
  }

  /** Bật — phải gọi từ một cú chạm/bấm. Nói ngay một câu để biết loa có kêu. */
  enable(): void {
    this.#enabled = true;
    try {
      localStorage.setItem(KEY, 'on');
    } catch {
      /* không lưu được thì chỉ bật cho phiên này */
    }
    this.say(OFFICE_GENERAL_LINES.greeting);
  }

  disable(): void {
    this.#enabled = false;
    try {
      localStorage.setItem(KEY, 'off');
    } catch {
      /* như trên */
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  /** Câu vừa đọc gần đây — nhiều phòng cùng đổi trạng thái thì không đọc lặp một câu liên tục. */
  #recent = new Map<string, number>();

  /** Đọc một câu; câu mới nối đuôi câu đang đọc, không chen ngang. Cùng một câu trong 45 giây chỉ đọc một lần. */
  say(text: string): void {
    if (!this.#enabled || typeof window === 'undefined') return;
    const now = Date.now();
    if (now - (this.#recent.get(text) ?? 0) < 45_000) return;
    this.#recent.set(text, now);
    this.#queue = this.#queue.then(async () => {
      if (await this.#useServer()) {
        const error = await this.#playServer(text);
        if (!error) return;
      }
      this.#speakLocal(text);
    });
  }

  /**
   * Nút "Nghe thử" ở trang Tích hợp: đọc ngay bằng Vbee, bỏ qua công tắc giọng nói của văn phòng.
   * Trả câu lỗi (để hiện cho CEO) hoặc null khi đã phát được.
   */
  async preview(text: string): Promise<string | null> {
    this.#server = null;
    // Lượt đầu sau lúc Vbee nghỉ có thể mất vài phút; nút Nghe thử chịu chờ tới 90 giây.
    return this.#playServer(text, 90);
  }

  /** Hỏi (một lần) Vbee đã nối chưa — menu Âm thanh gọi khi mở để hiện đúng tình trạng giọng. */
  async checkServer(): Promise<boolean> {
    return this.#useServer();
  }

  /** Hỏi API một lần xem Vbee đã nối chưa. */
  async #useServer(): Promise<boolean> {
    if (this.#server !== null) return this.#server;
    try {
      const response = await fetch(`${apiUrl()}/voice/status`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
      this.#server = response.ok && Boolean(((await response.json()) as { enabled?: boolean }).enabled);
    } catch {
      this.#server = false;
    }
    return this.#server;
  }

  /** Lấy mp3 từ API rồi phát hết câu mới trả về. Lỗi → câu lỗi (người gọi quay về giọng máy). */
  async #playServer(text: string, wait?: number): Promise<string | null> {
    try {
      const response = await fetch(`${apiUrl()}/voice/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify(wait ? { text, wait } : { text }),
      });
      if (!response.ok) {
        // Chưa nối (409): lần sau khỏi hỏi. Hết hạn mức (429) hay Vbee lỗi (502): chỉ câu này dùng giọng máy.
        if (response.status === 409) this.#server = false;
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        return body?.error ?? `HTTP ${response.status}`;
      }
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      // Nhạc nền văn phòng nhỏ lại trong lúc Khang nói cho rõ lời.
      officeAudio.duck(true);
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('Trình duyệt không phát được âm thanh'));
        audio.play().catch(reject);
      }).finally(() => {
        officeAudio.duck(false);
        URL.revokeObjectURL(url);
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Không phát được giọng Vbee';
    }
  }

  #speakLocal(text: string): void {
    const voice = this.#local();
    if (!voice) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 1;
    utterance.onstart = () => officeAudio.duck(true);
    utterance.onend = () => officeAudio.duck(false);
    window.speechSynthesis.speak(utterance);
  }

  /** Giọng tiếng Việt đầu tiên tìm thấy trong máy; ưu tiên giọng cài sẵn (không cần mạng). */
  #local(): SpeechSynthesisVoice | null {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    if (this.#voice) return this.#voice;
    const voices = window.speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith('vi'));
    this.#voice = voices.find((voice) => voice.localService) ?? voices[0] ?? null;
    return this.#voice;
  }
}

export const officeVoice = new OfficeVoice();
