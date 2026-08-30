import { useEffect, useRef, useState, type ReactNode } from "react";

export interface Choice {
  id: string;
  label: string;
  /** Shown right-aligned and dim: a hint, or in red, a reason it cannot be picked. */
  note?: string;
  disabled?: boolean;
}

/**
 * A flat menu. No captions, no cards — the label is the choice, and anything
 * that cannot be picked says why on the same line rather than in a paragraph
 * under it.
 */
export function Picker({ value, choices, onPick, kind, disabled, empty }: {
  value: string | undefined;
  choices: readonly Choice[];
  onPick: (id: string) => void;
  /** A dim prefix, so a bare value like `sonnet` says what it is. */
  kind?: string;
  disabled?: boolean;
  empty?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const showing = choices.find((choice) => choice.id === value);

  return (
    <div className="picker" ref={box}>
      <button
        type="button"
        disabled={disabled || choices.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {kind && <span className="kind">{kind}</span>}
        <span>{showing?.label ?? value ?? "—"}</span>
        {!disabled && choices.length > 0 && <span className="caret">▾</span>}
      </button>

      {open && (
        <div className="menu" role="menu">
          {choices.length === 0 && empty}
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="menuitem"
              disabled={choice.disabled}
              aria-current={choice.id === value}
              onClick={() => { setOpen(false); onPick(choice.id); }}
            >
              <span>{choice.label}</span>
              {choice.note && (
                <span className={choice.disabled ? "why" : "hint"}>{choice.note}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
