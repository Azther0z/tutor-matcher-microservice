"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AriaAttributes, CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type DropdownOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type DropdownProps = AriaAttributes & {
  id: string;
  name?: string;
  options: readonly DropdownOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
};

const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;
const MENU_MAX_HEIGHT = 288;
const TYPEAHEAD_DELAY = 700;

/** A single-select listbox. Focus stays on the trigger; named values participate in FormData. */
export function Dropdown({
  id,
  name,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Choose an option",
  disabled = false,
  ...aria
}: DropdownProps) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", time: 0 });
  const initialValue =
    defaultValue ?? options.find((option) => !option.disabled)?.value ?? "";
  const [internalValue, setInternalValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({});
  const selectedValue = value ?? internalValue;
  const selected = options.find((option) => option.value === selectedValue);
  const expanded = open && !disabled;
  const activeOption = options[activeIndex];

  function placeMenu() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const below =
      window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_PADDING;
    const above = rect.top - MENU_GAP - VIEWPORT_PADDING;
    const desiredHeight = Math.min(
      MENU_MAX_HEIGHT,
      list.current?.scrollHeight ?? options.length * 44 + 12,
    );
    const flip = below < desiredHeight && above > below;
    const width = Math.min(
      rect.width,
      window.innerWidth - VIEWPORT_PADDING * 2,
    );
    setPosition({
      left: Math.max(
        VIEWPORT_PADDING,
        Math.min(rect.left, window.innerWidth - width - VIEWPORT_PADDING),
      ),
      width,
      maxHeight: Math.max(0, Math.min(MENU_MAX_HEIGHT, flip ? above : below)),
      ...(flip
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
    });
  }

  function showMenu(index?: number) {
    // :disabled also covers a disabled ancestor fieldset.
    if (trigger.current?.matches(":disabled")) return;
    trigger.current?.focus({ preventScroll: true });
    const currentIndex = options.findIndex(
      (option) => option.value === selectedValue && !option.disabled,
    );
    setActiveIndex(
      index ??
        (currentIndex >= 0
          ? currentIndex
          : options.findIndex((option) => !option.disabled)),
    );
    typeahead.current = { text: "", time: 0 };
    placeMenu();
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled || trigger.current?.matches(":disabled"))
      return;
    if (value === undefined) setInternalValue(option.value);
    if (option.value !== selectedValue) onValueChange?.(option.value);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
    typeahead.current = { text: "", time: 0 };
  }

  useEffect(() => {
    const form = trigger.current?.form;
    function reset() {
      setInternalValue(initialValue);
      setOpen(false);
    }
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [initialValue]);

  useEffect(() => {
    if (!expanded) return;
    function dismiss(event: Event) {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !list.current?.contains(target))
        setOpen(false);
    }
    function reposition(event: Event) {
      if (event.target instanceof Node && list.current?.contains(event.target))
        return;
      placeMenu();
    }
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  });

  useEffect(() => {
    if (expanded && activeIndex >= 0) {
      document
        .getElementById(`${listId}-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded, activeIndex, listId]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      if (expanded) event.preventDefault();
      setOpen(false);
      typeahead.current = { text: "", time: 0 };
    } else if (event.key === "Tab") {
      if (expanded) choose(activeIndex);
    } else if (
      event.key === "Enter" ||
      (event.key === " " &&
        (!typeahead.current.text ||
          Date.now() - typeahead.current.time >= TYPEAHEAD_DELAY))
    ) {
      event.preventDefault();
      if (expanded) choose(activeIndex);
      else showMenu();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const enabled = options.flatMap((option, index) =>
        option.disabled ? [] : [index],
      );
      const current = enabled.indexOf(activeIndex);
      if (event.key === "Home") showMenu(enabled[0]);
      else if (event.key === "End") showMenu(enabled.at(-1));
      else if (!expanded) showMenu();
      else {
        const next = current + (event.key === "ArrowDown" ? 1 : -1);
        setActiveIndex(
          enabled[Math.max(0, Math.min(enabled.length - 1, next))] ?? -1,
        );
      }
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const now = Date.now();
      const text =
        (now - typeahead.current.time < TYPEAHEAD_DELAY
          ? typeahead.current.text
          : "") + event.key.toLocaleLowerCase();
      // Repeating one letter cycles through matching options.
      const repeated = [...text].every((letter) => letter === text[0]);
      const search = repeated ? text[0] : text;
      const start = expanded
        ? activeIndex
        : options.findIndex((option) => option.value === selectedValue);
      const offset = repeated ? 1 : 0;
      for (let step = 0; step < options.length; step++) {
        const index = (Math.max(start, 0) + offset + step) % options.length;
        if (
          !options[index].disabled &&
          options[index].label.toLocaleLowerCase().startsWith(search)
        ) {
          if (!expanded) showMenu(index);
          else setActiveIndex(index);
          break;
        }
      }
      typeahead.current = { text, time: now };
    }
  }

  return (
    <>
      {name && (
        <input
          type="hidden"
          name={name}
          value={selected?.value ?? ""}
          disabled={disabled}
        />
      )}
      <button
        {...aria}
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        className="dropdown-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={
          expanded && activeOption && !activeOption.disabled
            ? `${listId}-${activeIndex}`
            : undefined
        }
        onClick={() => (expanded ? setOpen(false) : showMenu())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        <span className="dropdown-value">{selected?.label ?? placeholder}</span>
        <svg
          className="dropdown-chevron"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {expanded &&
        createPortal(
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-labelledby={id}
            className="dropdown-menu"
            style={position}
            onPointerDown={(event) => event.preventDefault()}
          >
            {options.length === 0 && (
              <div
                className="dropdown-empty"
                role="option"
                aria-disabled="true"
                aria-selected="false"
              >
                No options available
              </div>
            )}
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === selectedValue}
                aria-disabled={option.disabled || undefined}
                className={`dropdown-option${index === activeIndex ? " is-active" : ""}`}
                onPointerMove={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === selectedValue && (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
