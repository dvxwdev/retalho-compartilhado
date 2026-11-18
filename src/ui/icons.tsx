const PATHS = {
  text: "M4 6V4h12v2M10 4v12M7.5 16h5",
  presets: "M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z",
  style: "M4 16l1-4 8-8 3 3-8 8-4 1zM11.5 5.5l3 3",
  position: "M10 3v14M3 10h14M10 3L8 5M10 3l2 2M10 17l-2-2M10 17l2-2M3 10l2-2M3 10l2 2M17 10l-2-2M17 10l-2 2",
  animate: "M16.5 10a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM6.5 7H3M5.5 10H2.5M6.5 13H3",
  crop: "M6 2.5V14h11.5M2.5 6H14v11.5",
  mask: "M3.5 3.5h13v13h-13zM13.5 10a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z",
  color: "M16.5 10a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM10 3.5v13M10 7l4.5-2.2M10 10.5l6.3-1.6M10 14l4.8 .6",
  effects: "M9 3l1.7 4.8L15.5 9.5l-4.8 1.7L9 16l-1.7-4.8L2.5 9.5l4.8-1.7zM15.5 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  speed: "M3.5 14.5a7.2 7.2 0 1 1 13 0M10 12.5l3.5-4.5",
  audio: "M3.5 8v4h3l4 3.5v-11l-4 3.5zM13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9",
  transition: "M3 5.5h8v9H3zM9 5.5h8v9H9z",
  background: "M3.5 4.5h13v11h-13zM3.5 13l4-4 3 3 2-2 4 4M13 8.2h.01",
  split: "M6 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM6 17a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM7.5 6.5L16 14M7.5 13.5L16 6",
  trash: "M4 6h12M8 6V4h4v2M5.5 6l1 10.5h7l1-10.5",
  ripple: "M3 4v12M17 4v12M6 10h3M14 10h-3M7.5 8.5L9 10l-1.5 1.5M12.5 8.5L11 10l1.5 1.5",
  copy: "M7.5 7.5h9v9h-9zM12.5 7.5v-4h-9v9h4",
  paste: "M6 4H4.5v12.5h11V4H14M7 2.5h6v3H7z",
  duplicate: "M3.5 3.5h9v9h-9zM7.5 16.5h9v-9",
  freeze: "M10 2.5v15M3.5 6.2l13 7.6M16.5 6.2l-13 7.6",
  extract: "M3.5 8v4M6.5 5v10M9.5 7v6M12.5 10h5M15.5 8l2 2-2 2",
  mic: "M7.5 4.5a2.5 2.5 0 0 1 5 0v5a2.5 2.5 0 0 1-5 0zM4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5",
  marker: "M5 17V3.5h10L12.5 7l2.5 3.5H5",
  undo: "M7 4L3.5 7.5 7 11M3.5 7.5H12a4.5 4.5 0 0 1 0 9H8",
  redo: "M13 4l3.5 3.5L13 11M16.5 7.5H8a4.5 4.5 0 0 0 0 9h4",
  file: "M5 2.5h7L15.5 6v11.5H5zM12 2.5V6h3.5M10 9v5M7.5 11.5h5",
  open: "M2.5 15.5v-11h5l2 2h8v9z",
  save: "M10 3v9M6.5 9L10 12.5 13.5 9M3.5 15.5h13",
  export: "M10 13V3M6.5 6.5L10 3l3.5 3.5M3.5 12v4.5h13V12",
  video: "M3 5h10.5v10H3zM13.5 8.5L17 6.5v7l-3.5-2",
  image: "M3.5 4.5h13v11h-13zM3.5 13l4-4 3 3 2-2 4 4",
  triangle: "M10 3.5l7.5 13h-15z",
  line: "M3 15L17 5",
  linear: "M3 10h14M3 13.5h14M3 6.5h14",
  rectangle: "M3.5 5.5h13v9h-13z",
  circle: "M16.5 10a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z",
  heart: "M10 16.5C4 12 2.5 9.5 2.5 7.2 2.5 5 4.2 3.5 6.2 3.5c1.6 0 3 .9 3.8 2.3.8-1.4 2.2-2.3 3.8-2.3 2 0 3.7 1.5 3.7 3.7 0 2.3-1.5 4.8-7.5 9.3z",
  star: "M10 2.5l2.3 4.9 5.2.7-3.8 3.7.9 5.4L10 14.6l-4.6 2.6.9-5.4L2.5 8.1l5.2-.7z",
  none: "M4.5 4.5l11 11M16.5 10a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z",
  alignLeft: "M3 5h14M3 10h9M3 15h12",
  alignCenter: "M3 5h14M5.5 10h9M4 15h12",
  alignRight: "M3 5h14M8 10h9M5 15h12",
} as const;

export type IconName = keyof typeof PATHS;

/** One drawn set, so every icon shares the same stroke and optical size. */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
