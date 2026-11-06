/**
 * P&N — Nhạc nền và hiệu ứng âm thanh của văn phòng 3D ("tựa như một game").
 *
 * Tự dựng bằng Web Audio ngay trong trình duyệt : không tải file nhạc, không lo bản quyền, và nhạc đổi theo
 * công ty — càng nhiều người đang làm thì tiếng đàn rải càng dày, bộ lọc càng mở, thêm tiếng shaker; công ty rảnh thì
 * chỉ còn lớp nền êm. Chỉ phát ở văn phòng (3D và sơ đồ 2D); rời trang là tắt dần.
 *
 * Nhạc: bốn hợp âm Rê trưởng (Dmaj9 → Bm9 → Gmaj9 → A add9), mỗi hợp âm hai ô nhịp, 78 nhịp/phút. Lớp nền (pad) là
 * hai sóng tam giác lệch nhau vài cent qua bộ lọc thấp; bass sóng sin; đàn rải sóng sin qua delay chấm dôi và hồi âm.
 * Hiệu ứng (âm nhiều hơn, to hơn, rõ hơn, phủ toàn bộ click của công ty): mỗi loại thao tác một
 * tiếng riêng — chuyển trang, đổi thẻ, nút xác nhận, nút nguy hiểm, công tắc, đóng bảng, rê menu, lưu thành công /
 * lỗi — do `components/ClickSounds.tsx` gắn cho MỌI trang; cộng các tiếng riêng của văn phòng (mở bảng nhân viên,
 * phóng vào phòng, chuyển giao việc, bắt đầu / xong / kẹt, có phiếu duyệt). Bộ nén ở đầu ra để tiếng to mà không rè.
 * Nhạc nền chỉ phát khi đang ở văn phòng (`enterOffice` / `leaveOffice`).
 *
 * Trình duyệt chỉ cho phát sau một cú chạm: `arm()` gọi từ cú chạm đầu tiên. Khang nói thì nhạc tự nhỏ lại (`duck`).
 * Bật/tắt và âm lượng nhớ ở máy (`pn.office.music`, `pn.office.sfx`).
 */

export type OfficeSfx =
  | 'click'
  | 'nav'
  | 'tab'
  | 'confirm'
  | 'danger'
  | 'toggle'
  | 'close'
  | 'hover'
  | 'success'
  | 'error'
  | 'open'
  | 'focus'
  | 'handoff'
  | 'start'
  | 'done'
  | 'alert'
  | 'notify';

const KEY = 'pn.office.audio';
const BPM = 78;
const SIXTEENTH = 60 / BPM / 4;
const STEPS_PER_CHORD = 32;
/** Hợp âm theo số MIDI: phần tử đầu là bass, còn lại là lớp nền. */
const CHORDS = [
  [38, 57, 61, 64, 66], // Dmaj9
  [35, 54, 57, 61, 62], // Bm9
  [31, 50, 54, 57, 59], // Gmaj9
  [33, 52, 59, 61, 64], // A add9
];
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

interface Prefs {
  music: boolean;
  sfx: boolean;
  musicVolume: number;
  sfxVolume: number;
}
const DEFAULTS: Prefs = { music: true, sfx: true, musicVolume: 0.5, sfxVolume: 0.85 };
/** Âm lượng thanh trượt → độ lớn bus hiệu ứng (bộ nén phía sau giữ cho không rè). */
const SFX_GAIN = 1.25;

class OfficeAudio {
  #prefs: Prefs = { ...DEFAULTS };
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #music!: GainNode;
  #sfx!: GainNode;
  #reverb!: ConvolverNode;
  #delay!: DelayNode;
  #noise!: AudioBuffer;
  #timer: number | null = null;
  #step = 0;
  #next = 0;
  #intensity = 0;
  #ducked = false;
  /** Đang ở trang văn phòng — chỉ lúc này mới có nhạc nền. */
  #inOffice = false;
  #listeners = new Set<() => void>();

  constructor() {
    try {
      const saved = typeof window === 'undefined' ? null : localStorage.getItem(KEY);
      if (saved) this.#prefs = { ...DEFAULTS, ...(JSON.parse(saved) as Partial<Prefs>) };
    } catch {
      /* không đọc được thì dùng mặc định */
    }
  }

  get prefs(): Prefs {
    return this.#prefs;
  }

  /** Giao diện đăng ký để nút "Âm thanh" cập nhật khi đổi ở nơi khác. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Gọi từ cú chạm (bất kỳ trang nào): dựng bộ âm thanh (một lần); đang ở văn phòng thì bắt đầu nhạc. */
  arm(): void {
    if (typeof window === 'undefined') return;
    if (!this.#ctx) this.#build();
    if (this.#ctx!.state !== 'running') void this.#ctx!.resume();
    if (this.#inOffice && this.#prefs.music) this.#startMusic();
  }

  /** Vào văn phòng: có nhạc nền (nếu đang bật và trình duyệt đã cho phát). */
  enterOffice(): void {
    this.#inOffice = true;
    if (this.#ctx && this.#prefs.music) this.#startMusic();
  }

  /** Rời văn phòng: nhạc tắt dần, ngừng soạn nốt. Hiệu ứng vẫn chạy ở mọi trang. */
  leaveOffice(): void {
    this.#inOffice = false;
    this.#stopMusic();
  }

  /** Mức bận của công ty 0–1 (số người đang làm / 6) — nhạc sôi dần theo. */
  setIntensity(value: number): void {
    this.#intensity = Math.max(0, Math.min(1, value));
    if (this.#ctx) this.#applyMusicLevel(0.8);
  }

  /** Khang đang nói: nhạc nhỏ lại cho rõ lời, nói xong trả lại. */
  duck(on: boolean): void {
    this.#ducked = on;
    if (this.#ctx) this.#applyMusicLevel(on ? 0.25 : 0.9);
  }

  update(change: Partial<Prefs>): void {
    this.#prefs = { ...this.#prefs, ...change };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#prefs));
    } catch {
      /* không lưu được thì chỉ áp dụng phiên này */
    }
    if (this.#ctx) {
      if (this.#prefs.music && this.#inOffice) this.#startMusic();
      else this.#stopMusic();
      this.#applyMusicLevel(0.3);
      this.#sfx.gain.setTargetAtTime(this.#prefs.sfx ? this.#prefs.sfxVolume * SFX_GAIN : 0, this.#ctx.currentTime, 0.05);
    }
    for (const listener of this.#listeners) listener();
  }

  /** Phát một hiệu ứng. Chưa có cú chạm nào (chưa `arm`) hoặc đang tắt thì im. */
  play(kind: OfficeSfx): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#prefs.sfx) return;
    // Cú chạm đầu tiên vừa mở khoá âm thanh: trình duyệt cần một nhịp để chạy — phát ngay khi chạy, không bỏ mất tiếng.
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => ctx.state === 'running' && this.play(kind));
      return;
    }
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    switch (kind) {
      // Bấm thường: tiếng "tách" gỗ — đầu sáng (tiếng ồn cao), thân tam giác trượt xuống, đáy trầm cho chắc tay.
      case 'click':
        this.#noiseHit(t, 3200, 0.012, 0.14, 'highpass');
        this.#blip(t, 1400, 700, 0.045, 0.3, 'triangle');
        this.#blip(t, 260, 170, 0.045, 0.16);
        break;
      // Chuyển trang: gió vút lên + một tiếng tách.
      case 'nav':
        this.#sweep(t, 700, 2800, 0.18, 0.16);
        this.#blip(t + 0.06, 2000, 1300, 0.045, 0.2, 'triangle');
        break;
      // Đổi thẻ: hai tiếng tách nhanh, nốt sau cao hơn.
      case 'tab':
        this.#blip(t, 1600, 1400, 0.035, 0.24, 'triangle');
        this.#blip(t + 0.05, 2300, 2050, 0.035, 0.2, 'triangle');
        break;
      // Nút xác nhận chính (Lưu, Tạo, Giao việc…): tách + hai nốt chuông đi lên.
      case 'confirm':
        this.#blip(t, 1400, 800, 0.035, 0.2, 'triangle');
        this.#bell(t + 0.02, 84, 0.2, 0.32);
        this.#bell(t + 0.08, 91, 0.16, 0.4);
        break;
      // Nút nguy hiểm (Xoá, Khoá, Dừng): hai nốt trầm đi xuống, sắc hơn.
      case 'danger':
        this.#bell(t, 57, 0.2, 0.22, 'square', 1000);
        this.#bell(t + 0.09, 52, 0.2, 0.3, 'square', 900);
        break;
      // Công tắc: tiếng "bóc" ngắn đi lên.
      case 'toggle':
        this.#blip(t, 800, 1400, 0.05, 0.26, 'triangle');
        this.#noiseHit(t + 0.03, 4000, 0.01, 0.08, 'highpass');
        break;
      // Đóng bảng: đi xuống + gió nhẹ.
      case 'close':
        this.#blip(t, 1300, 650, 0.06, 0.24, 'triangle');
        this.#sweep(t, 2400, 700, 0.16, 0.08);
        break;
      // Rê chuột qua menu: tiếng tích rất nhỏ.
      case 'hover':
        this.#blip(t, 3000, 2700, 0.014, 0.06);
        break;
      // Lưu / gửi thành công: ba nốt Sol trưởng đi lên.
      case 'success':
        [79, 83, 86].forEach((note, i) => this.#bell(t + 0.04 + i * 0.065, note, 0.18, 0.5));
        break;
      // Lỗi: hai nốt trầm, sóng vuông lọc.
      case 'error':
        this.#bell(t, 52, 0.2, 0.28, 'square', 750);
        this.#bell(t + 0.12, 49, 0.2, 0.4, 'square', 700);
        break;
      case 'open':
        this.#bell(t, 81, 0.2, 0.3);
        this.#bell(t + 0.07, 88, 0.2, 0.38);
        break;
      case 'focus':
        this.#sweep(t, 400, 2400, 0.38, 0.18);
        this.#blip(t + 0.3, 1800, 1200, 0.05, 0.16, 'triangle');
        break;
      case 'handoff':
        this.#sweep(t, 1800, 600, 0.32, 0.14);
        this.#blip(t + 0.26, 880, 1320, 0.07, 0.18, 'triangle');
        break;
      case 'start':
        this.#bell(t, 74, 0.16, 0.45);
        this.#bell(t + 0.06, 81, 0.12, 0.45);
        break;
      case 'done':
        [74, 78, 81, 86].forEach((note, i) => this.#bell(t + i * 0.08, note, 0.18, 0.65));
        break;
      case 'alert':
        this.#bell(t, 69, 0.2, 0.25, 'square', 1200);
        this.#bell(t + 0.13, 65, 0.2, 0.35, 'square', 1200);
        break;
      case 'notify':
        this.#bell(t, 88, 0.18, 1.2);
        this.#bell(t, 95, 0.08, 1.0);
        this.#bell(t + 0.18, 93, 0.14, 1.0);
        break;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Dựng bộ âm thanh                                                          */
  /* ------------------------------------------------------------------------ */

  #build(): void {
    const ctx = new AudioContext();
    this.#ctx = ctx;
    this.#master = ctx.createGain();
    this.#master.gain.value = 1;
    // Bộ nén trước loa: hiệu ứng to, rõ nhưng nhiều tiếng chồng nhau không vỡ, không rè.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 8;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.#master.connect(limiter).connect(ctx.destination);

    // Hồi âm: tiếng ồn tắt dần 2,8 giây — đủ "không gian" cho một văn phòng lớn mà không cần file impulse.
    this.#reverb = ctx.createConvolver();
    const length = Math.floor(ctx.sampleRate * 2.8);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
    this.#reverb.buffer = impulse;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.#reverb.connect(wet).connect(this.#master);

    // Delay chấm dôi (3 nốt móc kép) cho đàn rải.
    this.#delay = ctx.createDelay(1);
    this.#delay.delayTime.value = SIXTEENTH * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    this.#delay.connect(feedback).connect(this.#delay);
    this.#delay.connect(this.#reverb);

    this.#music = ctx.createGain();
    this.#music.gain.value = 0;
    this.#music.connect(this.#master);
    this.#sfx = ctx.createGain();
    this.#sfx.gain.value = this.#prefs.sfx ? this.#prefs.sfxVolume * SFX_GAIN : 0;
    this.#sfx.connect(this.#master);

    this.#noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const noise = this.#noise.getChannelData(0);
    for (let i = 0; i < noise.length; i += 1) noise[i] = Math.random() * 2 - 1;

    // Tab ẩn thì trình duyệt bóp nhịp hẹn giờ — nốt dồn cục khi quay lại. Tạm dừng hẳn cho sạch.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void ctx.suspend();
      else void ctx.resume();
    });
  }

  #applyMusicLevel(seconds: number): void {
    const ctx = this.#ctx!;
    const base = this.#prefs.music ? this.#prefs.musicVolume * (0.22 + this.#intensity * 0.08) : 0;
    this.#music.gain.setTargetAtTime(this.#ducked ? base * 0.3 : base, ctx.currentTime, seconds / 3);
  }

  #startMusic(): void {
    const ctx = this.#ctx!;
    this.#applyMusicLevel(3);
    if (this.#timer !== null) return;
    this.#step = 0;
    this.#next = ctx.currentTime + 0.1;
    // Soạn nốt trước 0,3 giây theo đồng hồ âm thanh (chính xác), hẹn giờ chỉ để đánh thức — nhịp không bị lệch.
    this.#timer = window.setInterval(() => {
      while (this.#next < ctx.currentTime + 0.3) {
        this.#schedule(this.#step, this.#next);
        this.#next += SIXTEENTH;
        this.#step += 1;
      }
    }, 50);
  }

  #stopMusic(): void {
    if (!this.#ctx) return;
    this.#music.gain.setTargetAtTime(0, this.#ctx.currentTime, 0.6);
    if (this.#timer !== null) window.clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Một bước móc kép của bản nhạc. */
  #schedule(step: number, t: number): void {
    const chord = CHORDS[Math.floor(step / STEPS_PER_CHORD) % CHORDS.length]!;
    const inChord = step % STEPS_PER_CHORD;
    const busy = this.#intensity;

    if (inChord === 0) {
      const length = STEPS_PER_CHORD * SIXTEENTH;
      for (const note of chord.slice(1)) this.#pad(t, note, length);
    }
    // Bass nhịp 1 và 3 của mỗi ô nhịp; công ty bận thì thêm nhịp lấy đà.
    if (inChord % 8 === 0 || (busy > 0.5 && inChord % 16 === 14)) this.#bass(t, chord[0]!, inChord % 8 === 0 ? 1 : 0.6);
    // Đàn rải móc đơn, dày dần theo mức bận.
    if (step % 2 === 0 && Math.random() < 0.18 + busy * 0.55) {
      const tones = chord.slice(1).map((note) => note + 12);
      const note = tones[(step / 2 + Math.floor(step / 16)) % tones.length]!;
      this.#pluck(t, note);
    }
    // Shaker nhẹ ở phách lẻ khi có người làm.
    if (busy > 0.15 && step % 4 === 2) this.#noiseHit(t, 7000, 0.04, 0.012 + busy * 0.012, 'highpass', this.#music);
  }

  /* ------------------------------------------------------------------------ */
  /* Nhạc cụ                                                                   */
  /* ------------------------------------------------------------------------ */

  #pad(t: number, note: number, length: number): void {
    const ctx = this.#ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 650 + this.#intensity * 1100;
    filter.Q.value = 0.6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.06, t + 1.8);
    env.gain.setValueAtTime(0.06, t + length - 0.2);
    env.gain.linearRampToValueAtTime(0, t + length + 2.2);
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz(note);
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + length + 2.4);
    }
    filter.connect(env);
    env.connect(this.#music);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    env.connect(send).connect(this.#reverb);
  }

  #bass(t: number, note: number, level: number): void {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz(note);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.16 * level, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    osc.connect(env).connect(this.#music);
    osc.start(t);
    osc.stop(t + 1.5);
  }

  #pluck(t: number, note: number): void {
    const ctx = this.#ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 0.8 - 0.4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.055, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0008, t + 0.7);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz(note);
    const shimmer = ctx.createOscillator();
    shimmer.type = 'triangle';
    shimmer.frequency.value = hz(note + 12);
    const quiet = ctx.createGain();
    quiet.gain.value = 0.25;
    osc.connect(env);
    shimmer.connect(quiet).connect(env);
    env.connect(pan).connect(this.#music);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    pan.connect(send).connect(this.#delay);
    osc.start(t);
    shimmer.start(t);
    osc.stop(t + 0.75);
    shimmer.stop(t + 0.75);
  }

  /* ------------------------------------------------------------------------ */
  /* Hiệu ứng                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Tiếng "tách" ngắn: sóng trượt tần số. */
  #blip(t: number, from: number, to: number, length: number, level: number, type: OscillatorType = 'sine'): void {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(level, t);
    env.gain.exponentialRampToValueAtTime(0.0005, t + length);
    osc.connect(env).connect(this.#sfx);
    osc.start(t);
    osc.stop(t + length + 0.01);
  }

  /** Tiếng chuông / đàn một nốt, có chút hồi âm. */
  #bell(t: number, note: number, level: number, decay: number, type: OscillatorType = 'triangle', cutoff = 6000): void {
    const ctx = this.#ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz(note);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0005, t + decay);
    osc.connect(filter).connect(env);
    env.connect(this.#sfx);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    env.connect(send).connect(this.#reverb);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  /** Tiếng gió "vút": tiếng ồn qua bộ lọc dải trượt tần số. */
  #sweep(t: number, from: number, to: number, length: number, level: number): void {
    const ctx = this.#ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.#noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + length * 0.4);
    env.gain.linearRampToValueAtTime(0, t + length);
    source.connect(filter).connect(env).connect(this.#sfx);
    source.start(t);
    source.stop(t + length + 0.02);
  }

  #noiseHit(t: number, freq: number, length: number, level: number, type: BiquadFilterType, out: AudioNode = this.#sfx): void {
    const ctx = this.#ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.#noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(level, t);
    env.gain.exponentialRampToValueAtTime(0.0005, t + length);
    source.connect(filter).connect(env).connect(out);
    source.start(t, Math.random() * 0.5);
    source.stop(t + length + 0.01);
  }
}

export const officeAudio = new OfficeAudio();
