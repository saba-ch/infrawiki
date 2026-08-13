import { Text, useInput } from "ink";
import { useState } from "react";

// Terminals emit sequences like "\x1b[27;2;13~" (modifyOtherKeys Shift+Enter)
// that ink passes through as input; strip them (with or without the leading
// ESC, since ink may consume it) along with any remaining control chars.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control sequences is the point
const CONTROL_SEQUENCES = /\u001b?\[[0-9;]+[~A-Za-z]|[\u0000-\u001f\u007f]/g;

interface Props {
  defaultValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
}

export function TextInput({
  defaultValue = "",
  placeholder = "",
  onSubmit,
}: Props) {
  const [value, setValue] = useState(defaultValue);

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    // Ink already blanks `input` for named keys (arrows, esc, tab, ...);
    // only ctrl/meta combos still carry the plain letter through.
    if (key.ctrl || key.meta) return;
    const clean = input.replace(CONTROL_SEQUENCES, "");
    if (clean) setValue((v) => v + clean);
  });

  return (
    <Text>
      {value ? <Text>{value}</Text> : <Text dimColor>{placeholder}</Text>}
      <Text inverse> </Text>
    </Text>
  );
}
