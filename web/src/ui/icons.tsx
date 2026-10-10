// Small line icons for the toolbar and the side panels (stand-ins for the SF Symbols of the
// Mac app). Drawn in a 20x20 box with the current text color.

import type { ReactNode } from "react";

export type IconName =
  | "sidebarLeft"
  | "sidebarRight"
  | "grid"
  | "noteAdd"
  | "linkAdd"
  | "terminal"
  | "zoomIn"
  | "zoomOut"
  | "share"
  | "undo"
  | "redo"
  | "search"
  | "clear"
  | "plus"
  | "warning"
  | "trash"
  | "cable"
  | "note"
  | "multi"
  | "project"
  | "chevronRight"
  | "chevronDown"
  | "close"
  | "file";

const paths: Record<IconName, ReactNode> = {
  sidebarLeft: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="M7.5 3.5v13M4.5 6.5h1M4.5 8.5h1M4.5 10.5h1" />
    </>
  ),
  sidebarRight: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="M12.5 3.5v13M14.5 6.5h1M14.5 8.5h1M14.5 10.5h1" />
    </>
  ),
  grid: <path d="M7.5 3v14M12.5 3v14M3 7.5h14M3 12.5h14" strokeWidth="1.7" />,
  noteAdd: (
    <>
      <rect x="2.5" y="3.5" width="12" height="13" rx="2" />
      <path d="M5.5 7.5h6M5.5 10.5h6M5.5 13.5h3M15.5 11v6M12.5 14h6" />
    </>
  ),
  linkAdd: (
    <>
      <path d="M8.2 11.8l3.6-3.6" />
      <path d="M9.6 6.4l1.5-1.5a3 3 0 0 1 4.2 4.2l-1.5 1.5M10.4 13.6l-1.5 1.5a3 3 0 0 1-4.2-4.2l1.5-1.5" />
      <path d="M15.5 13v5M13 15.5h5" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M5.5 8l2.5 2-2.5 2M9.5 13h4" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.2 12.2l4.6 4.6M6.3 8.5h4.4M8.5 6.3v4.4" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.2 12.2l4.6 4.6M6.3 8.5h4.4" />
    </>
  ),
  share: <path d="M10 2.8v10M6.5 6.2L10 2.8l3.5 3.4M7 9H5.5a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14.5 9H13" />,
  undo: <path d="M7.5 5L4 8.5 7.5 12M4.5 8.5h7a4 4 0 0 1 0 8H9" />,
  redo: <path d="M12.5 5L16 8.5 12.5 12M15.5 8.5h-7a4 4 0 0 0 0 8H11" />,
  search: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.2 12.2l4.3 4.3" />
    </>
  ),
  clear: (
    <>
      <circle cx="10" cy="10" r="7" fill="currentColor" stroke="none" opacity="0.55" />
      <path d="M7.5 7.5l5 5M12.5 7.5l-5 5" stroke="var(--clear-glyph, #fff)" />
    </>
  ),
  plus: <path d="M10 4v12M4 10h12" />,
  warning: (
    <>
      <path d="M10 3.2L17.6 16.4H2.4Z" strokeLinejoin="round" />
      <path d="M10 8.2v4" />
      <circle cx="10" cy="14.2" r="0.6" fill="currentColor" />
    </>
  ),
  trash: <path d="M4 5.5h12M8 5.5V4h4v1.5M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5.5M11.5 8.5v5.5" />,
  cable: (
    <>
      <rect x="6.5" y="2.5" width="7" height="7" rx="1.2" />
      <path d="M8.5 2.5v2M11.5 2.5v2M10 9.5v3.5a3.5 3.5 0 0 1-3.5 3.5H4" />
    </>
  ),
  note: (
    <>
      <rect x="3.5" y="2.5" width="13" height="15" rx="2" />
      <path d="M6.5 6.5h7M6.5 9.5h7M6.5 12.5h4" />
    </>
  ),
  multi: (
    <>
      <rect x="2.5" y="2.5" width="10" height="10" rx="1.5" strokeDasharray="2 2" />
      <rect x="7.5" y="7.5" width="10" height="10" rx="1.5" />
    </>
  ),
  project: (
    <>
      <circle cx="5" cy="5.5" r="2" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="15" r="2" />
      <path d="M7 5.8l6 1M14 8.8l-3.8 4.6M6 7.3l2.2 5.9" strokeDasharray="1.6 1.4" />
    </>
  ),
  chevronRight: <path d="M8 5l5 5-5 5" strokeWidth="2" />,
  chevronDown: <path d="M5 8l5 5 5-5" strokeWidth="2" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  file: (
    <>
      <path d="M5 2.5h6.5L15.5 6.5V17.5H5Z" strokeLinejoin="round" />
      <path d="M11.5 2.5v4h4" />
    </>
  ),
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
