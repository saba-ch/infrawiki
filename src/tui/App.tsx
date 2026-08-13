import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { AuthStore } from "../auth/store";
import type { Catalog } from "../catalog";
import type { Config, InitCheckpoint, InitResult } from "../config";
import { INSTRUCTIONS_HINT, Instructions } from "./screens/Instructions";
import { MODEL_HINT, Model } from "./screens/Model";
import { OUTPUT_DIR_HINT, OutputDir } from "./screens/OutputDir";
import { Welcome } from "./screens/Welcome";

type StepId = InitCheckpoint["step"];

const STEPS: { id: StepId; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "output-dir", label: "Output" },
  { id: "instructions", label: "Instructions" },
];

const STEP_HINTS: Record<StepId, string> = {
  model: MODEL_HINT,
  "output-dir": OUTPUT_DIR_HINT,
  instructions: INSTRUCTIONS_HINT,
};

const BADGE = {
  done: { glyph: "✓", color: "green" },
  current: { glyph: "❯", color: "cyan" },
  pending: { glyph: "○", color: "gray" },
} as const;

function seedDetails(config: Config): Partial<Record<StepId, string>> {
  const step = config.checkpoint?.step;
  const details: Partial<Record<StepId, string>> = {};
  if (step === "output-dir" || step === "instructions") {
    if (config.model) details.model = config.model;
  }
  if (step === "instructions") details["output-dir"] = config.outputDir;
  return details;
}

interface Props {
  config: Config;
  catalog?: Promise<Catalog | undefined>;
}

export function App({ config, catalog: catalogPromise }: Props) {
  const [gated, setGated] = useState(
    config.initialized || config.checkpoint !== undefined,
  );
  const [active, setActive] = useState<StepId>(
    config.checkpoint?.step ?? "model",
  );
  const [details, setDetails] = useState<Partial<Record<StepId, string>>>(() =>
    seedDetails(config),
  );
  const [result, setResult] = useState<InitResult | null>(null);
  const [store] = useState(() => AuthStore.load(config.stateDir));
  const [catalog, setCatalog] = useState<Catalog | undefined>();
  const [catalogReady, setCatalogReady] = useState(!catalogPromise);
  const { exit } = useApp();

  useEffect(() => {
    let stale = false;
    catalogPromise?.then((loaded) => {
      if (stale) return;
      setCatalog(loaded);
      setCatalogReady(true);
    });
    return () => {
      stale = true;
    };
  }, [catalogPromise]);

  // The model step owns its esc handling (internal phase navigation).
  useInput((_input, key) => {
    if (!key.escape || result) return;
    if (active === "output-dir") setActive("model");
    else if (active === "instructions") setActive("output-dir");
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
                setActive("model");
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
              <Text dimColor> model {config.model}</Text>
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
                {active === "model" &&
                  (catalogReady ? (
                    <Model
                      catalog={catalog}
                      store={store}
                      onSubmit={(modelId, providers, detail) => {
                        config.update({
                          model: modelId,
                          providers: { ...config.providers, ...providers },
                          init: { step: "output-dir" },
                        });
                        setDetails((d) => ({ ...d, model: detail }));
                        setActive("output-dir");
                      }}
                    />
                  ) : (
                    <Text dimColor>Loading model catalog…</Text>
                  ))}
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
                {active === "model" ? "" : " · esc back"}
              </Text>
            </>
          )}
        </>
      )}
    </Box>
  );
}
