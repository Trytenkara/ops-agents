"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// App-styled select. Replaces the native <select> so dropdowns render with our
// design tokens (cream surface, cyan active row) instead of the OS menu.
// Drop-in for the value/onChange/options pattern used across the app.

export type SelectOption = { value: string; label: string; disabled?: boolean };

interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Accessible label when there's no visible <label> wired to the trigger. */
  ariaLabel?: string;
  /** Trigger height: matches the h-8 (filter bars) / h-9 (forms) the app uses. */
  size?: "sm" | "md";
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  ariaLabel,
  size = "md",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeahead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({ buffer: "", timer: null });
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const triggerLabel = selected?.label ?? placeholder ?? "Select…";

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // When opening, highlight the selected row and focus the list for key nav.
  useEffect(() => {
    if (open) {
      setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
      listRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function commit(index: number) {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    onValueChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(delta: number) {
    setActive((cur) => {
      let next = cur;
      for (let i = 0; i < options.length; i++) {
        next = (next + delta + options.length) % options.length;
        if (!options[next]?.disabled) return next;
      }
      return cur;
    });
  }

  function runTypeahead(char: string) {
    const ta = typeahead.current;
    if (ta.timer) clearTimeout(ta.timer);
    ta.buffer += char.toLowerCase();
    ta.timer = setTimeout(() => (ta.buffer = ""), 600);
    const match = options.findIndex(
      (o) => !o.disabled && o.label.toLowerCase().startsWith(ta.buffer)
    );
    if (match >= 0) setActive(match);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveActive(1); break;
      case "ArrowUp": e.preventDefault(); moveActive(-1); break;
      case "Home": e.preventDefault(); setActive(firstEnabled(options)); break;
      case "End": e.preventDefault(); setActive(lastEnabled(options)); break;
      case "Enter":
      case " ": e.preventDefault(); if (active >= 0) commit(active); break;
      case "Escape": e.preventDefault(); setOpen(false); triggerRef.current?.focus(); break;
      case "Tab": setOpen(false); break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) runTypeahead(e.key);
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent text-sm shadow-sm",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "h-8 px-2" : "h-9 px-3 py-1"
        )}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>{triggerLabel}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={cn("h-3.5 w-3.5 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
        >
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
          onKeyDown={onListKeyDown}
          className={cn(
            "absolute z-50 mt-1 max-h-60 min-w-full overflow-auto rounded-md border border-border bg-background p-1 shadow-md",
            "focus:outline-none"
          )}
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            const isActive = i === active;
            return (
              <li
                key={o.value || `__opt_${i}`}
                id={`${listId}-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onClick={() => commit(i)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                  o.disabled && "pointer-events-none opacity-50",
                  isActive && !o.disabled && "bg-accent text-accent-foreground",
                  !isActive && isSelected && "bg-secondary"
                )}
              >
                <span className="w-3.5 shrink-0 text-center">{isSelected ? "✓" : ""}</span>
                <span className="truncate">{o.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function firstEnabled(options: SelectOption[]): number {
  const i = options.findIndex((o) => !o.disabled);
  return i;
}
function lastEnabled(options: SelectOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}
