/**
 * Icon set — one hand-drawn 24px stroke family (1.6px, round caps), authored
 * for this plugin so the reading desk does not inherit someone else's glyph
 * vocabulary. Icons inherit `currentColor`; decorative ones are `aria-hidden`.
 */

import type { CSSProperties, ReactElement } from 'react'

/** Every icon name used by the plugin. */
export const ICON_PATHS = {
  book: 'M5 4.5h9.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3zM7 4.5v15M19 7.5h1.5v12H9',
  graph: 'M6 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17.5 8 6.5 14.5M9 5h6M5 17h13',
  search: 'M10.8 17.6a6.8 6.8 0 1 1 0-13.6 6.8 6.8 0 0 1 0 13.6ZM15.8 15.8 20 20',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  settings:
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z',
  chevronDown: 'M6 9.5 12 15.5 18 9.5',
  chevronRight: 'm9.5 6 6 6-6 6',
  chevronLeft: 'm14.5 6-6 6 6 6',
  arrowRight: 'M4.5 12h15M14 6.5l5.5 5.5L14 17.5',
  arrowLeft: 'M19.5 12h-15M10 6.5 4.5 12 10 17.5',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm4.5 12.5 5 5L19.5 7',
  searchSpark: 'M10.8 17.6a6.8 6.8 0 1 1 0-13.6 6.8 6.8 0 0 1 0 13.6ZM15.8 15.8 20 20M17.5 5.5v5M15 8h5',
  sparkle:
    'M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9ZM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z',
  highlight: 'm9 15-4 4M7 13l6.5-9 6.5 6.5-9 6.5zM13.5 6.5l4 4M5 20h6',
  note: 'M5 4.5h14v11l-4.5 4.5H5zM14.5 20v-4.5H19M8.5 9h7M8.5 12.5h4.5',
  translate: 'M4.5 6.5h8M8.5 4.5v2M6 6.5c.5 3.5 2.5 6 5.5 7.5M11.5 6.5c-.5 3.5-2.5 6.5-5.5 8M13.5 19.5l3.5-9 3.5 9M15 16.5h4.5',
  copy: 'M8.5 8.5h10v10h-10zM15.5 5.5h-10v10',
  download: 'M12 4.5v10M8 11l4 4 4-4M5 19.5h14',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  stop: 'M7 7h10v10H7z',
  send: 'M4.5 12 20 4.5l-4 15-4.2-6.3L4.5 12ZM11.8 13.2 20 4.5',
  more: 'M6 12h.5M12 12h.5M18 12h.5',
  pin: 'M9 4.5h6l-1 5 3.5 4H6.5L10 9.5zM12 13.5v6',
  merge: 'M8 5v5a4 4 0 0 0 4 4h4M16 11l3 3-3 3M8 19v-5',
  external: 'M14 5h5v5M19 5l-7 7M11 5H5v14h14v-6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7.5v.5',
  alert: 'M12 3.5 21.5 20h-19ZM12 9.5v4.5M12 17v.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  panelLeft: 'M4 5h16v14H4zM9.5 5v14',
  panelRight: 'M4 5h16v14H4zM14.5 5v14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  zoomIn: 'M10.8 17.6a6.8 6.8 0 1 1 0-13.6 6.8 6.8 0 0 1 0 13.6ZM15.8 15.8 20 20M10.8 7.5v6.5M7.5 10.8h6.5',
  zoomOut: 'M10.8 17.6a6.8 6.8 0 1 1 0-13.6 6.8 6.8 0 0 1 0 13.6ZM15.8 15.8 20 20M7.5 10.8h6.5',
  trash: 'M5 7h14M9.5 7V4.5h5V7M7 7l1 13h8l1-13M10.5 11v5.5M13.5 11v5.5',
  edit: 'M4.5 19.5h4L20 8l-4-4L4.5 15.5zM14 6l4 4',
  upload: 'M12 15.5v-11M8 8.5l4-4 4 4M5 19.5h14',
  file: 'M6 3.5h8.5L19 8v12.5H6zM14 3.5v5h5M9 13h6M9 16.5h4',
  columns: 'M4 5h16v14H4zM9.3 5v14M14.7 5v14',
  list: 'M8 6.5h12M8 12h12M8 17.5h12M4.5 6.5h.5M4.5 12h.5M4.5 17.5h.5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  layers: 'M12 3.5 21 8l-9 4.5L3 8zM3 12.5 12 17l9-4.5M3 16.5 12 21l9-4.5',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5',
  bookmark: 'M6.5 4.5h11v16L12 16.5 6.5 20.5z',
  filter: 'M4 5.5h16l-6 7v5.5l-4 2v-7.5z',
  sort: 'M7 4.5v15M4 16.5l3 3 3-3M17 19.5v-15M14 7.5l3-3 3 3',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4',
  moon: 'M20.5 13.5A8.5 8.5 0 0 1 10.5 3.5a8.5 8.5 0 1 0 10 10Z',
} as const

export type IconName = keyof typeof ICON_PATHS

/** Props of the icon component. */
export interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
  title?: string
}

/** Render one icon. */
export function Icon({ name, size = 18, strokeWidth = 1.6, className, style, title }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
    >
      {title === undefined ? null : <title>{title}</title>}
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}
