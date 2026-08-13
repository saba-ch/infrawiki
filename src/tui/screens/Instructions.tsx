import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Text, useInput, useStdin } from "ink";
import { useState } from "react";
import { DEFAULT_INSTRUCTIONS } from "../../config";

interface Props {
  onSubmit: (instructions: string, detail: string) => void;
}

const EDITOR = process.env.VISUAL ?? process.env.EDITOR ?? "vi";

export const INSTRUCTIONS_HINT = `enter use this text · e edit in ${EDITOR}`;

export function Instructions({ onSubmit }: Props) {
  const [text, setText] = useState(DEFAULT_INSTRUCTIONS);
  const { setRawMode } = useStdin();

  useInput((input, key) => {
    if (key.return) {
      onSubmit(
        text,
        text === DEFAULT_INSTRUCTIONS
          ? "default template"
          : `custom (${text.trimEnd().split("\n").length} lines)`,
      );
      return;
    }
    if (input === "e") {
      const file = join(tmpdir(), `infrawiki-instructions-${process.pid}.md`);
      writeFileSync(file, text);
      setRawMode(false);
      spawnSync(EDITOR, [file], { stdio: "inherit" });
      setRawMode(true);
      setText(readFileSync(file, "utf8"));
      rmSync(file, { force: true });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Wiki instructions</Text>
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>{text.trimEnd()}</Text>
      </Box>
    </Box>
  );
}
