import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Config, InitCheckpoint, InitResult } from "../config";
import { INSTRUCTIONS_HINT, Instructions } from "./screens/Instructions";
import { OUTPUT_DIR_HINT, OutputDir } from "./screens/OutputDir";
import { Welcome } from "./screens/Welcome";

type StepId = InitCheckpoint["step"];

const STEPS: { id: StepId; label: string }[] = [
  { id: "output-dir", label: "Output" },
  { id: "instructions", label: "Instructions" },
];

const STEP_HINTS: Record<StepId, string> = {
  "output-dir": OUTPUT_DIR_HINT,
  instructions: INSTRUCTIONS_HINT,
};

const BADGE = {
  done: { glyph: "✓", color: "green" },
  current: { glyph: "❯", color: "cyan" },
  pending: { glyph: "○", color: "gray" },
} as const;

export function App({ config }: { config: Config }) {
  const [gated, setGated] = useState(
    config.initialized || config.checkpoint !== undefined,
  );
  const [active, setActive] = useState<StepId>(
    config.checkpoint?.step ?? "output-dir",
  );
  const [details, setDetails] = useState<Partial<Record<StepId, string>>>(() =>
    config.checkpoint?.step === "instructions"
      ? { "output-dir": config.outputDir }
      : {},
  );
  const [result, setResult] = useState<InitResult | null>(null);
  const { exit } = useApp();

  useInput((_input, key) => {
    if (key.escape && active === "instructions" && !result) {
      setActive("output-dir");
    }
  });

  // Exit after the final frame is painted so it stays in the terminal.
  useEffect(() => {
    if (result) exit();
  }, [result, exit]);

  // Active step wins over done (revisiting shows ❯), except in the final
  // done state where everything completed shows ✓.
  const stepStatus = (id: StepId) => {
    if (!result && id === active) return "current";
    if (details[id]) return "done";
    return "pending";
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold color="cyan">
        InfraWiki
      </Text>
      {gated ? (
        <Box flexDirection="column" marginTop={1}>
          <Welcome
            initialized={config.initialized}
            onStart={(mode) => {
              if (mode === "fresh") {
                setDetails({});
                setActive("output-dir");
              }
              setGated(false);
            }}
            onCancel={exit}
          />
          <Box marginTop={1}>
            <Text dimColor>↑↓ choose · enter select</Text>
          </Box>
        </Box>
      ) : (
        <>
          <Box flexDirection="column" marginTop={1}>
            {STEPS.map((step) => {
              const badge = BADGE[stepStatus(step.id)];
              return (
                <Box key={step.id}>
                  <Box width={16}>
                    <Text color={badge.color}>
                      {badge.glyph} {step.label}
                    </Text>
                  </Box>
                  <Text dimColor>{details[step.id] ?? ""}</Text>
                </Box>
              );
            })}
          </Box>
          {result ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Wiki initialized</Text>
              <Text dimColor> config {result.configPath}</Text>
              <Text dimColor> state {result.stateDir}</Text>
            </Box>
          ) : (
            <>
              <Box
                flexDirection="column"
                marginTop={1}
                paddingX={1}
                borderStyle="round"
                borderColor="gray"
              >
                {active === "output-dir" && (
                  <OutputDir
                    defaultValue={details["output-dir"] ?? config.outputDir}
                    onSubmit={(value) => {
                      setDetails((d) => ({ ...d, "output-dir": value }));
                      config.update({
                        outputDir: value,
                        init: { step: "instructions" },
                      });
                      setActive("instructions");
                    }}
                  />
                )}
                {active === "instructions" && (
                  <Instructions
                    onSubmit={(instructions, detail) => {
                      setDetails((d) => ({ ...d, instructions: detail }));
                      setResult(config.initialize(instructions));
                    }}
                  />
                )}
              </Box>
              <Text dimColor>
                {STEP_HINTS[active]}
                {active === "instructions" ? " · esc back" : ""}
              </Text>
            </>
          )}
        </>
      )}
    </Box>
  );
}
