/**
 * P&N — Nét icon dùng chung ngoài thanh điều hướng (chuông, dấu cộng, cảnh báo…).
 *
 * Cùng bút pháp với NavIcon trong Shell (nét tròn, không tô), để icon trong ô
 * 3D, ô số liệu và thẻ dự án nhìn cùng một bộ.
 */

const GLYPH = {
  bell: 'M6 16v-5a6 6 0 1 1 12 0v5l1.6 2.2H4.4zM10 20.5a2 2 0 0 0 4 0',
  plus: 'M12 5v14M5 12h14',
  alert: 'M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  folder: 'M3.5 6.5h6l1.5 2h9.5v11h-17zM3.5 6.5v-2h6l1.5 2',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm2.5-13.5H11a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9.5M12 5v13',
  chevron: 'm9 6 6 6-6 6',
  spark: 'm12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8zM19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7z',
  logout: 'M9.5 4H5v16h4.5M14 8l4 4-4 4m4-4H9',
  more: 'M5 7h14M5 12h14M5 17h14',
} as const;

export type GlyphName = keyof typeof GLYPH;

export function Glyph({
  name,
  size = 20,
  stroke = 1.9,
  className = '',
}: {
  name: GlyphName;
  size?: number;
  stroke?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={GLYPH[name]} />
    </svg>
  );
}
