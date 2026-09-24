import type { SVGProps } from 'react';

/** One consistent 16px stroke icon set (currentColor), so every control speaks the same visual language. */
const paths: Record<string, string> = {
  play: 'M5 3.5v9l7.5-4.5z',
  pause: 'M5 3.5h2v9H5zM9 3.5h2v9H9z',
  prev: 'M11.5 3.5v9L5 8zM4 3.5v9',
  next: 'M4.5 3.5v9L11 8zM12 3.5v9',
  first: 'M12 3.5v9L6.5 8zM4 3.5v9',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4 4l8 8M12 4l-8 8',
  sparkle: 'M8 2.5l1.3 3.7L13 7.5l-3.7 1.3L8 12.5l-1.3-3.7L3 7.5l3.7-1.3zM12.5 11l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z',
  code: 'M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5',
  wand: 'M3 13l7-7M9 4l1-1.5L11 4l1.5 1L11 6l-1 1.5L9 6 7.5 5zM12.5 9.5l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.5a1 1 0 1 0 0-.01',
  upload: 'M8 10.5V3M5 6l3-3 3 3M3 10.5v2h10v-2',
  download: 'M8 3v7.5M5 7.5l3 3 3-3M3 10.5v2h10v-2',
  grid: 'M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11',
  onion: 'M5.5 4.5h6v7h-6zM3.5 6.5v6h6',
  pivot: 'M8 2.5v11M2.5 13.5h11M6 11.5h4',
  loop: 'M3 7a4 4 0 0 1 7-2.6l1.5 1.1M13 9a4 4 0 0 1-7 2.6l-1.5-1.1M11.5 3v2.5H9M4.5 13v-2.5H7',
  pingpong: 'M2.5 5.5h9l-2-2M13.5 10.5h-9l2 2',
  keyboard: 'M1.5 4.5h13v7h-13zM4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6',
  film: 'M2.5 3h11v10h-11zM5 3v10M11 3v10M2.5 6h2.5M2.5 10h2.5M11 6h2.5M11 10h2.5',
  users: 'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4M11 7.5a2 2 0 1 0 0-4M12.5 9.8c1 .6 1.7 1.9 2 3.7',
  palette: 'M8 2.5a5.5 5.5 0 1 0 0 11c.8 0 1.2-.6 1-1.3-.3-.9.3-1.7 1.2-1.7H12a1.5 1.5 0 0 0 1.5-1.5A5.5 5.5 0 0 0 8 2.5zM5 7h.01M7 4.8h.01M10 5h.01',
  layers: 'M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8.5L8 11.5l5.5-3M2.5 11L8 14l5.5-3',
  alert: 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.3h.01',
  info: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM8 7.5v3.5M8 5.3h.01',
  refresh: 'M13 4.5v3h-3M3 11.5v-3h3M12.4 7A4.5 4.5 0 0 0 4 5.5M3.6 9a4.5 4.5 0 0 0 8.4 1.5',
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  external: 'M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5',
  speed: 'M8 13.5a5.5 5.5 0 1 1 5.5-5.5M8 8l3-3',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5l3 3',
  expand: 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3',
  dot: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  stop: 'M4.5 4.5h7v7h-7z',
  gemini: 'M8 1.5c.5 3.4 3.1 6 6.5 6.5-3.4.5-6 3.1-6.5 6.5-.5-3.4-3.1-6-6.5-6.5 3.4-.5 6-3.1 6.5-6.5z',
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = name === 'play' || name === 'pause' || name === 'stop' || name === 'dot' || name === 'gemini';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" {...rest}
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
