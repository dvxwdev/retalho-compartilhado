import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { getState, setState, useEditor } from "../store";

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="group">
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}

interface FieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  trailing?: ReactNode;
}

/** The track fills from zero, so a value below zero reads as going the other way. */
function fillOf(value: number, min: number, max: number): CSSProperties {
  const percent = (point: number) => ((Math.min(max, Math.max(min, point)) - min) / (max - min)) * 100;
  const zero = percent(0);
  const current = percent(value);
  return {
    "--fill-from": `${Math.min(zero, current)}%`,
    "--fill-to": `${Math.max(zero, current)}%`,
  } as CSSProperties;
}

export function Field({ label, value, min, max, step, onChange, trailing }: FieldProps) {
  const rounded = Number(value.toFixed(3));
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={fillOf(value, min, max)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        className="field-number"
        type="number"
        aria-label={`${label}, valor`}
        step={step}
        value={rounded}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {trailing ? <span className="field-trailing">{trailing}</span> : null}
    </label>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

interface ChoiceProps<T extends string> {
  label: string;
  value: T;
  options: ChoiceOption<T>[];
  onChange(value: T): void;
  testId: string;
  columns?: number;
  /** Shows icons alone, with the name as a tooltip, for shapes that explain themselves. */
  iconsOnly?: boolean;
}

/** All options in view and one click away, for short lists a dropdown would only hide. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  columns = 4,
  iconsOnly = false,
}: ChoiceProps<T>) {
  return (
    <div
      className="choice"
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={`choice-item${option.icon ? " has-icon" : ""}${iconsOnly ? " icon-only" : ""}`}
          title={iconsOnly ? option.label : undefined}
          aria-label={iconsOnly ? option.label : undefined}
          data-testid={`${testId}-${option.value || "none"}`}
          data-empty={option.value ? undefined : ""}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={16} /> : null}
          {iconsOnly ? null : <span>{option.label}</span>}
        </button>
      ))}
    </div>
  );
}

export interface Section {
  id: string;
  label: string;
  isSet?: boolean;
  render(): ReactNode;
}

/** Splits a category that outgrew one screen, so nothing ever needs scrolling. */
export function Sections({ pageId, items }: { pageId: string; items: Section[] }) {
  const stored = useEditor((current) => current.panelSection[pageId]);
  const open = items.find((item) => item.id === stored) ?? items[0]!;
  return (
    <>
      <div className="subtabs" role="tablist" aria-label="Seções">
        {items.map(({ id, label, isSet }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === open.id}
            className="subtab"
            data-testid={`sub-${id}`}
            onClick={() => setState({ panelSection: { ...getState().panelSection, [pageId]: id } })}
          >
            {label}
            {isSet ? <i className="subtab-dot" /> : null}
          </button>
        ))}
      </div>
      {open.render()}
    </>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  testId,
  children,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <label className="field field-select">
      <span className="field-label">{label}</span>
      <select data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

export function Swatch({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  testId?: string;
}) {
  return (
    <label className="swatch">
      <input
        type="color"
        aria-label={label}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** A named switch; the trailing slot holds what belongs to it, like its colour. */
export function Toggle({
  label,
  checked,
  onChange,
  testId,
  children,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="toggle-row">
      <label className="toggle">
        <input
          type="checkbox"
          role="switch"
          data-testid={testId}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {children}
    </div>
  );
}
