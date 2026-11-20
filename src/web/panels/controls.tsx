import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HexAlphaColorPicker } from 'react-colorful';
import { useEditor } from '../store.ts';

export const MIXED = Symbol('mixed');
export type Mixed<T> = T | typeof MIXED;

// ---------------------------------------------------------------------------
// Number field with drag-to-scrub label
// ---------------------------------------------------------------------------

function evalExpr(s: string): number | null {
  const t = s.trim().replace(/px$/i, '');
  if (!t) return null;
  if (!/^[\d+\-*/.() ]+$/.test(t)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${t})`)();
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function fmt(v: number) {
  return String(Math.round(v * 100) / 100);
}

export function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  allowToken,
  title,
  suffix,
  disabled,
  width,
  placeholder,
}: {
  label: ReactNode;
  value: Mixed<number | string | undefined>;
  onChange: (v: number | string, opts: { scrub?: boolean }) => void;
  min?: number;
  max?: number;
  step?: number;
  allowToken?: boolean;
  title?: string;
  suffix?: string;
  disabled?: boolean;
  width?: number;
  placeholder?: string;
}) {
  const display = value === MIXED ? 'Mixed' : value === undefined ? '' : typeof value === 'number' ? fmt(value) : value;
  const [text, setText] = useState(display);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(display);
  }, [display, focused]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commitText = () => {
    if (text === display) return;
    if (allowToken && text.trim().startsWith('$')) {
      onChange(text.trim(), {});
      return;
    }
    const v = evalExpr(text);
    if (v === null) setText(display);
    else onChange(clamp(v), {});
  };
  const scrub = useRef<{ x: number; v: number } | null>(null);
  return (
    <label className={`numfield ${disabled ? 'disabled' : ''}`} title={title} style={width ? { width } : undefined}>
      {label !== '' && <span
        className="numfield-label"
        onPointerDown={(e) => {
          if (disabled || typeof value !== 'number') return;
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, v: value };
        }}
        onPointerMove={(e) => {
          if (!scrub.current) return;
          const dx = e.clientX - scrub.current.x;
          const v = clamp(scrub.current.v + Math.round(dx / 2) * step * (e.shiftKey ? 10 : 1));
          onChange(Math.round(v * 100) / 100, { scrub: true });
        }}
        onPointerUp={() => (scrub.current = null)}
      >
        {label}
      </span>}
      <input
        value={focused ? text : display}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={(e) => {
          setFocused(true);
          setText(display === 'Mixed' ? '' : display);
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={() => {
          setFocused(false);
          commitText();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(display);
            (e.target as HTMLInputElement).blur();
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && typeof value === 'number') {
            e.preventDefault();
            const v = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
            onChange(v, { scrub: true });
            setText(fmt(v));
          }
        }}
      />
      {suffix && <span className="numfield-suffix">{suffix}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

let ctx2d: CanvasRenderingContext2D | null = null;
/** Normalize any CSS color to #rrggbb or #rrggbbaa. */
export function toHex(c: string | undefined): string {
  if (!c) return '#000000';
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return c.toUpperCase();
  if (/^#[0-9a-f]{3,4}$/i.test(c)) {
    const s = c.slice(1).split('').map((x) => x + x).join('');
    return ('#' + s).toUpperCase();
  }
  ctx2d ??= document.createElement('canvas').getContext('2d');
  if (!ctx2d) return '#000000';
  ctx2d.fillStyle = '#000000';
  ctx2d.fillStyle = c;
  const v = ctx2d.fillStyle as string;
  if (v.startsWith('#')) return v.toUpperCase();
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return '#000000';
  const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x));
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return ('#' + h(r) + h(g) + h(b) + (a !== undefined && a < 1 ? h(a * 255) : '')).toUpperCase();
}

export function alphaOf(hex: string): number {
  return hex.length === 9 ? Math.round((parseInt(hex.slice(7, 9), 16) / 255) * 100) : 100;
}

export function withAlpha(hex: string, pct: number): string {
  const base = hex.slice(0, 7);
  if (pct >= 100) return base;
  return base + Math.round((Math.max(0, pct) / 100) * 255).toString(16).padStart(2, '0').toUpperCase();
}

export function useTokenValue(c: string | undefined): string | undefined {
  const vars = useEditor((s) => s.doc?.variables);
  if (!c || !c.startsWith('$')) return c;
  const name = c.slice(1);
  const v = Object.values(vars ?? {}).find((x) => x.name === name);
  return v ? String(v.value) : undefined;
}

export function Popover({ anchor, onClose, children, width = 240 }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 300;
    let left = r.left - width - 12;
    if (left < 8) left = Math.min(window.innerWidth - width - 8, r.right + 8);
    let top = r.top - 40;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    setPos({ left, top: Math.max(8, top) });
  }, [anchor, width]);
  useEffect(() => {
    const on = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', on, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', on, true);
      window.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="popover" style={{ left: pos.left, top: pos.top, width }}>
      {children}
    </div>,
    document.body,
  );
}

export function ColorField({ value, onChange, allowTokens = true }: { value: string | undefined; onChange: (v: string, opts: { scrub?: boolean }) => void; allowTokens?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const resolved = useTokenValue(value);
  const isToken = !!value?.startsWith('$');
  const hex = toHex(resolved);
  const [text, setText] = useState(hex.slice(1, 7));
  useEffect(() => setText(hex.slice(1, 7)), [hex]);
  const vars = useEditor((s) => s.doc?.variables);
  const colorTokens = Object.values(vars ?? {}).filter((v) => v.type === 'color');
  return (
    <div className="colorfield">
      <button ref={btn} className="swatch" onClick={() => setOpen((o) => !o)} title={value}>
        <span style={{ background: resolved ?? 'transparent' }} />
      </button>
      {isToken ? (
        <button className="token-chip" onClick={() => setOpen(true)} title="Bound to a design token">
          {value!.slice(1)}
        </button>
      ) : (
        <>
          <input
            className="hex"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              const t = text.trim().replace(/^#/, '');
              if (/^[0-9a-f]{6}$/i.test(t)) onChange(withAlpha('#' + t.toUpperCase(), alphaOf(hex)), {});
              else if (/^[0-9a-f]{3}$/i.test(t)) onChange(toHex('#' + t), {});
              else if (t.startsWith('$')) onChange(t, {});
              else setText(hex.slice(1, 7));
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <NumField label="" value={alphaOf(hex)} min={0} max={100} suffix="%" width={52} onChange={(v, o) => onChange(withAlpha(hex, Number(v)), o)} />
        </>
      )}
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)}>
          <HexAlphaColorPicker color={hex} onChange={(c) => onChange(c.toUpperCase(), { scrub: true })} />
          {allowTokens && (
            <div className="token-list">
              <div className="token-list-title">Design tokens</div>
              {colorTokens.length === 0 && <div className="muted small">No color tokens yet. Add them in the Tokens tab.</div>}
              {colorTokens.map((t) => (
                <button key={t.id} className={`token-row ${value === '$' + t.name ? 'active' : ''}`} onClick={() => onChange('$' + t.name, {})}>
                  <span className="dot" style={{ background: String(t.value) }} />
                  {t.name}
                  <span className="muted">{String(t.value)}</span>
                </button>
              ))}
              {isToken && (
                <button className="token-row" onClick={() => onChange(hex, {})}>
                  Detach token
                </button>
              )}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function Section({ title, children, actions, collapsible }: { title: ReactNode; children?: ReactNode; actions?: ReactNode; collapsible?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="psection">
      <header onClick={() => collapsible && setOpen(!open)}>
        <span>{title}</span>
        <div className="psection-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      </header>
      {open && children && <div className="psection-body">{children}</div>}
    </section>
  );
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`prow ${className}`}>{children}</div>;
}

export function IconBtn({ title, onClick, active, children, disabled, className = '' }: { title: string; onClick?: () => void; active?: boolean; children: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <button className={`iconbtn ${active ? 'active' : ''} ${className}`} title={title} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Select<T extends string>({ value, options, onChange, title, className = '' }: { value: T | ''; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; title?: string; className?: string }) {
  return (
    <select className={`select ${className}`} value={value} title={title} onChange={(e) => onChange(e.target.value as T)}>
      {value === '' && <option value="">Mixed</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`btn small ${className}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}
