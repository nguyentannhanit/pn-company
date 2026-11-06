/** Vật liệu tại máy: vân gỗ, thảm dệt và màn hình sắc nét, không phụ thuộc CDN. */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';
const textures = new Map<string, CanvasTexture>();

/** Tạo và lưu texture dùng chung cho mọi phòng ban. */
function paint(
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): CanvasTexture {
  const saved = textures.get(key);
  if (saved) return saved;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  textures.set(key, texture);
  return texture;
}

/** Hạt nhiễu cố định để vân không đổi khi nhân viên đổi trạng thái. */
function noise(seed: number): number {
  const n = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/** Các thanh gỗ có mạch nối lệch nhau và vân chạy theo chiều dài. */
export function woodTexture(): CanvasTexture {
  const texture = paint('oak-floor', 512, 512, (ctx) => {
    for (let row = 0; row < 8; row++) {
      const y = row * 64;
      ctx.fillStyle = ['#c4a37d', '#c9ac86', '#bfa07d', '#d2b38e'][row % 4]!;
      ctx.fillRect(0, y, 512, 64);
      for (let i = 0; i < 90; i++) {
        ctx.strokeStyle = 'rgba(94,62,35,' + (0.018 + noise(i + row * 90) * 0.06) + ')';
        ctx.lineWidth = 0.7;
        const ly = y + noise(i * 3 + row) * 62;
        ctx.beginPath();
        ctx.moveTo(0, ly);
        ctx.bezierCurveTo(145, ly + 3, 390, ly - 3, 512, ly + 1);
        ctx.stroke();
      }
      ctx.fillStyle = '#9f8467';
      ctx.fillRect(0, y, 512, 1);
      ctx.fillRect((row % 3) * 145 + 64, y, 1, 64);
      ctx.fillStyle = '#e1c59f';
      ctx.fillRect(0, y + 1, 512, 1);
    }
  });
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

/** Sợi thảm có chi tiết ở cận cảnh và giữ màu dịu khi nhìn xa. */
export function carpetTexture(): CanvasTexture {
  const texture = paint('woven-carpet', 128, 128, (ctx) => {
    ctx.fillStyle = '#87999f';
    ctx.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 2)
      for (let x = 0; x < 128; x += 2) {
        ctx.fillStyle = 'rgba(229,235,229,' + noise(x + y * 128) * 0.16 + ')';
        ctx.fillRect(x, y, 1, 2);
      }
  });
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(6, 6);
  return texture;
}

export type ScreenKind =
  | 'code'
  | 'design'
  | 'kanban'
  | 'dashboard'
  | 'mobile'
  | 'terminal'
  | 'security'
  | 'pipeline'
  | 'meeting'
  | 'chart';

/** Nội dung trang trí theo chuyên môn; ACTIVE/STANDBY phản ánh trạng thái nhận vào. */
export function screenTexture(kind: ScreenKind, active = false): CanvasTexture {
  return paint('screen-' + kind + active, 640, 360, (ctx) => {
    ctx.fillStyle = '#152c3d';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#294454';
    ctx.fillRect(0, 0, 640, 34);
    for (const [i, color] of ['#d59789', '#d4bb85', '#86b9a6'].entries()) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(17 + i * 16, 17, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#c9d9dd';
    ctx.font = '12px sans-serif';
    ctx.fillText('P&N  /  ' + kind.toUpperCase(), 100, 22);
    ctx.fillStyle = active ? '#79d9b2' : '#8a9da8';
    ctx.fillText(active ? 'ACTIVE' : 'STANDBY', 553, 22);
    if (['design', 'mobile', 'kanban'].includes(kind)) {
      ctx.fillStyle = '#ecede8';
      ctx.fillRect(16, 49, 608, 294);
      for (let col = 0; col < 3; col++) {
        const x = 35 + col * 199;
        ctx.fillStyle = ['#bdadcb', '#a1bec7', '#d7c5a4'][col]!;
        ctx.fillRect(x, 66, 170, 12);
        for (let row = 0; row < 3; row++) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, 91 + row * 78, 170, 63);
          ctx.fillStyle = '#c5d2d3';
          ctx.fillRect(x + 12, 104 + row * 78, 86, 5);
          ctx.fillStyle = ['#728fa0', '#a18eaf', '#b99c76'][row]!;
          ctx.fillRect(x + 12, 119 + row * 78, kind === 'kanban' ? 17 : 143, 23);
        }
      }
    } else if (['dashboard', 'chart', 'pipeline', 'meeting'].includes(kind)) {
      ctx.strokeStyle = '#2d4b5b';
      ctx.lineWidth = 1;
      for (let y = 70; y < 350; y += 40) {
        ctx.beginPath();
        ctx.moveTo(20, y);
        ctx.lineTo(620, y);
        ctx.stroke();
      }
      for (let series = 0; series < 3; series++) {
        ctx.strokeStyle = ['#79bcca', '#c6ae80', '#9dbba1'][series]!;
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let x = 0; x < 39; x++) {
          const y =
            173 + series * 40 + Math.sin(x * 0.23 + series * 2) * 45 + Math.cos(x * 0.7) * 10;
          if (x === 0) ctx.moveTo(22, y);
          else ctx.lineTo(22 + x * 15, y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = '#aabfca';
      ctx.font = '14px sans-serif';
      ctx.fillText('WORKSPACE / ' + (active ? 'SESSION ACTIVE' : 'READY'), 25, 65);
    } else {
      ctx.fillStyle = '#203c4d';
      ctx.fillRect(0, 34, 125, 326);
      const lines = [
        'workspace/',
        '  src/',
        '  components/',
        '  services/',
        '  tests/',
        '  package.json',
      ];
      ctx.font = '12px monospace';
      ctx.fillStyle = '#9aafbd';
      lines.forEach((s, i) => ctx.fillText(s, 10, 62 + i * 25));
      const code = [
        'export async function execute(task) {',
        '  const context = await workspace.load();',
        '  const result = await agent.run({',
        '    project: context.project,',
        '    input: task.description,',
        '  });',
        '',
        '  await workspace.save(result);',
        '  return result;',
        '}',
      ];
      ctx.font = '14px monospace';
      code.forEach((line, i) => {
        ctx.fillStyle = '#617d90';
        ctx.fillText(String(i + 1).padStart(2, '0'), 140, 63 + i * 26);
        ctx.fillStyle = ['#9fbaca', '#bdafd0', '#89c7ba', '#d6ba8e'][i % 4]!;
        ctx.fillText(line, 174, 63 + i * 26);
      });
    }
  });
}

/** Biển hiệu gắn trên mặt tiền, cùng chịu phối cảnh của toà nhà. */
export function signTexture(title: string, subtitle: string): CanvasTexture {
  return paint('sign-' + title + subtitle, 1024, 96, (ctx) => {
    ctx.fillStyle = '#263c48';
    ctx.fillRect(0, 0, 1024, 96);
    ctx.fillStyle = '#dec8a0';
    ctx.font = 'bold 54px sans-serif';
    ctx.fillText('P&N', 28, 67);
    ctx.fillStyle = '#f3f3e9';
    ctx.font = 'bold 29px sans-serif';
    ctx.fillText(title, 210, 43);
    ctx.fillStyle = '#9ab2bc';
    ctx.font = '18px sans-serif';
    ctx.fillText(subtitle, 211, 74);
  });
}
