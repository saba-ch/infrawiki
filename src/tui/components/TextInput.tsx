import { Text, useInput } from "ink";
import { useState } from "react";

// Terminals emit sequences like "\x1b[27;2;13~" (modifyOtherKeys Shift+Enter)
// that ink passes through as input; strip them (with or without the leading
// ESC, since ink may consume it) along with any remaining control chars.
export const CONTROL_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control sequences is the point
  /\u001b?\[[0-9;]+[~A-Za-z]|[\u0000-\u001f\u007f]/g;

interface Props {
  placeholder?: string;
  mask?: boolean;
  onSubmit: (value: string) => void;
}

export function TextInput({ placeholder = "", mask = false, onSubmit }: Props) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      // Cmd/Alt+Backspace clears the line: it arrives as meta ("\x1b\x7f") or,
      // under the kitty protocol, as super. Plain backspace deletes one char.
      setValue((v) => (key.meta || key.super ? "" : v.slice(0, -1)));
      return;
    }
    // Terminals that map Cmd+Backspace to the readline "kill line" code send
    // Ctrl+U instead of a backspace key.
    if (key.ctrl && input === "u") {
      setValue("");
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
      {value ? (
        <Text>{mask ? "•".repeat(value.length) : value}</Text>
      ) : (
        <Text dimColor>{placeholder}</Text>
      )}
      <Text inverse> </Text>
    </Text>
  );
}
