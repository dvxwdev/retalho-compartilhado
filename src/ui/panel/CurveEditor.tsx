import { useRef, type PointerEvent } from "react";
import { IDENTITY_CURVE, curveTable, type CurvePoint } from "../../core/curves";

const SIZE = 150;
const GRAB_DISTANCE = 0.06;
const MAX_POINTS = 8;

const COLORS = { master: "#e6e7e9", red: "#e2675f", green: "#5fbf6e", blue: "#5f9be2" };

interface CurveEditorProps {
  points: CurvePoint[] | undefined;
  channel: keyof typeof COLORS;
  onChange(points: CurvePoint[], key?: string): void;
}

/** Click to add a point, drag to move it, and double-click one to remove it. */
export function CurveEditor({ points = IDENTITY_CURVE, channel, onChange }: CurveEditorProps) {
  const box = useRef<SVGSVGElement>(null);
  const table = curveTable(points);
  const line = Array.from(table, (value, step) => `${(step / 255) * SIZE},${(1 - value) * SIZE}`).join(" ");

  const locate = (event: { clientX: number; clientY: number }): CurvePoint => {
    const rect = box.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
    return [x, y];
  };

  const nearest = ([x, y]: CurvePoint) => {
    const index = points.findIndex(([px, py]) => Math.hypot(px - x, py - y) < GRAB_DISTANCE);
    return index;
  };

  const begin = (event: PointerEvent<SVGSVGElement>) => {
    const start = locate(event);
    let index = nearest(start);
    let current = points;
    if (index < 0) {
      if (points.length >= MAX_POINTS) return;
      current = [...points, start].sort((a, b) => a[0] - b[0]);
      index = current.indexOf(start);
      onChange(current, "curve");
    }
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const isEnd = index === 0 || index === current.length - 1;
    const move = (next: globalThis.PointerEvent) => {
      const [x, y] = locate(next);
      const before = current[index - 1]?.[0] ?? 0;
      const after = current[index + 1]?.[0] ?? 1;
      const held = isEnd ? current[index]![0] : Math.min(after - 0.01, Math.max(before + 0.01, x));
      current = current.map((point, position) => (position === index ? [held, y] : point));
      onChange(current, "curve");
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
  };

  return (
    <svg
      ref={box}
      className="curve"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label="Curva de cor"
      data-testid="curve"
      onPointerDown={begin}
      onDoubleClick={(event) => {
        const index = nearest(locate(event));
        if (index > 0 && index < points.length - 1) onChange(points.filter((_, position) => position !== index));
      }}
    >
      {[0.25, 0.5, 0.75].map((step) => (
        <g key={step} className="curve-grid">
          <line x1={step * SIZE} y1={0} x2={step * SIZE} y2={SIZE} />
          <line x1={0} y1={step * SIZE} x2={SIZE} y2={step * SIZE} />
        </g>
      ))}
      <polyline points={line} fill="none" stroke={COLORS[channel]} strokeWidth="1.5" />
      {points.map(([x, y], index) => (
        <circle key={index} cx={x * SIZE} cy={(1 - y) * SIZE} r="3.5" fill={COLORS[channel]} />
      ))}
    </svg>
  );
}
