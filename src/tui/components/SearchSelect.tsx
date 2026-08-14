import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { CONTROL_SEQUENCES } from "./TextInput";

interface Option {
  label: string;
  value: string;
  hint?: string;
}

interface Props {
  options: Option[];
  onSelect: (value: string) => void;
  /** Fired on tab for the highlighted option. */
  onTab?: (value: string) => void;
  /** Fired on right arrow for the highlighted option. */
  onRightArrow?: (value: string) => void;
}

const PLACEHOLDER = "type to filter";
const MAX_VISIBLE = 8;

// Type-to-filter select for long lists (providers, models). Substring match
// on label and value, windowed to MAX_VISIBLE rows around the highlight.
export function SearchSelect({
  options,
  onSelect,
  onTab,
  onRightArrow,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const needle = query.toLowerCase();
  const filtered = needle
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          o.value.toLowerCase().includes(needle),
      )
    : options;
  const clamped = Math.min(index, Math.max(filtered.length - 1, 0));

  useInput((input, key) => {
    const selected = filtered[clamped];
    if (key.upArrow) {
      setIndex(clamped > 0 ? clamped - 1 : Math.max(filtered.length - 1, 0));
      return;
    }
    if (key.downArrow) {
      setIndex(filtered.length ? (clamped + 1) % filtered.length : 0);
      return;
    }
    if (key.return) {
      if (selected) onSelect(selected.value);
      return;
    }
    if (key.tab) {
      if (selected && onTab) onTab(selected.value);
      return;
    }
    if (key.rightArrow) {
      if (selected && onRightArrow) onRightArrow(selected.value);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setIndex(0);
      return;
    }
    if (key.ctrl || key.meta) return;
    const clean = input.replace(CONTROL_SEQUENCES, "");
    if (clean) {
      setQuery((q) => q + clean);
      setIndex(0);
    }
  });

  const start = Math.max(
    0,
    Math.min(
      clamped - Math.floor(MAX_VISIBLE / 2),
      filtered.length - MAX_VISIBLE,
    ),
  );
  const visible = filtered.slice(start, start + MAX_VISIBLE);

  return (
    <Box flexDirection="column">
      <Text>
        {query ? <Text>{query}</Text> : <Text dimColor>{PLACEHOLDER}</Text>}
        <Text inverse> </Text>
      </Text>
      {filtered.length === 0 ? (
        <Text dimColor>no matches</Text>
      ) : (
        visible.map((option, i) => {
          const active = start + i === clamped;
          return (
            <Text
              key={option.value}
              color={active ? "cyan" : undefined}
              dimColor={!active}
            >
              {active ? "❯ " : "  "}
              {option.label}
              {option.hint ? <Text dimColor> {option.hint}</Text> : null}
            </Text>
          );
        })
      )}
    </Box>
  );
}
