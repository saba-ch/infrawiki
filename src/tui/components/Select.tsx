import { Box, Text, useInput } from "ink";
import { useState } from "react";

interface Option {
  label: string;
  value: string;
}

interface Props {
  options: Option[];
  onSelect: (value: string) => void;
}

// Stateless-by-design: only tracks the highlight, never "commits", so it
// stays interactive across repeated selections (e.g. edit -> return -> edit).
export function Select({ options, onSelect }: Props) {
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i > 0 ? i - 1 : options.length - 1));
    } else if (key.downArrow) {
      setIndex((i) => (i + 1) % options.length);
    } else if (key.return) {
      const selected = options[index];
      if (selected) onSelect(selected.value);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((option, i) => (
        <Text
          key={option.value}
          color={i === index ? "cyan" : undefined}
          dimColor={i !== index}
        >
          {i === index ? "❯ " : "  "}
          {option.label}
        </Text>
      ))}
    </Box>
  );
}
