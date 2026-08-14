import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { runGeneration } from "../agent/loop";
import { AuthStore } from "../auth/store";
import type { Catalog } from "../catalog";
import type { Config, InitCheckpoint, InitResult } from "../config";
import { type AwsApi, createAwsApi } from "../connectors/aws";
import { createModel, type ProviderModel } from "../model";
import { clearSources, formatSourcesDetail, listSources } from "../sources";
import { GENERATE_HINT, Generate } from "./screens/Generate";
import { INSTRUCTIONS_HINT, Instructions } from "./screens/Instructions";
import { MODEL_HINT, Model } from "./screens/Model";
import { OUTPUT_DIR_HINT, OutputDir } from "./screens/OutputDir";
import { Sources } from "./screens/Sources";
import { Welcome } from "./screens/Welcome";

type StepId = InitCheckpoint["step"];
type UiStep = StepId | "generate";

const STEPS: { id: UiStep; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "sources", label: "Sources" },
  { id: "output-dir", label: "Output" },
  { id: "instructions", label: "Instructions" },
  { id: "generate", label: "Generate" },
];

// The sources step's hint is dynamic (reported by the screen per phase);
// the rest are static.
const STEP_HINTS: Record<Exclude<StepId, "sources">, string> = {
  model: MODEL_HINT,
  "output-dir": OUTPUT_DIR_HINT,
  instructions: INSTRUCTIONS_HINT,
};

const BADGE = {
  done: { glyph: "✓", color: "green" },
  current: { glyph: "❯", color: "cyan" },
  pending: { glyph: "○", color: "gray" },
} as const;

function seedDetails(config: Config): Partial<Record<UiStep, string>> {
  const step = config.checkpoint?.step;
  const details: Partial<Record<UiStep, string>> = {};
  if (step === "sources" || step === "output-dir" || step === "instructions") {
    if (config.model) details.model = config.model;
  }
  if (step === "output-dir" || step === "instructions") {
    details.sources = formatSourcesDetail(listSources(config.stateDir));
  }
  if (step === "instructions") details["output-dir"] = config.outputDir;
  return details;
}

interface Props {
  config: Config;
  catalog?: Promise<Catalog | undefined>;
  /** Test seam: skips createModel so tests can inject a mock model. */
  model?: ProviderModel;
  /** Test seam: fake AWS client layer for the sources step. */
  awsApi?: AwsApi;
}

export function App({
  config,
  catalog: catalogPromise,
  model: modelOverride,
  awsApi: awsApiOverride,
}: Props) {
  const [gated, setGated] = useState(
    config.initialized || config.checkpoint !== undefined,
  );
  const [active, setActive] = useState<StepId>(
    config.checkpoint?.step ?? "model",
  );
  const [details, setDetails] = useState<Partial<Record<UiStep, string>>>(() =>
    seedDetails(config),
  );
  const [result, setResult] = useState<InitResult | null>(null);
  const [summary, setSummary] = useState<{ error?: string } | null>(null);
  const [store] = useState(() => AuthStore.load(config.stateDir));
  // Lazy: constructing the real API does no IO until a method is called.
  const [awsApi] = useState(() => awsApiOverride ?? createAwsApi());
  const [sourcesHint, setSourcesHint] = useState("");
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

  // The model and sources steps own their esc handling (internal phase
  // navigation), and the generate step owns esc as cancel.
  useInput((_input, key) => {
    if (!key.escape || result) return;
    if (active === "output-dir") setActive("sources");
    else if (active === "instructions") setActive("output-dir");
  });

  // Exit after the final frame is painted so it stays in the terminal.
  useEffect(() => {
    if (summary) exit();
  }, [summary, exit]);

  const startGeneration = (initResult: InitResult) => (signal: AbortSignal) =>
    (async () => {
      const model =
        modelOverride ??
        (await createModel({
          // The model step runs before generate and persists the model id.
          modelId: config.model as string,
          store,
          providers: config.providers,
          catalog,
        }));
      return runGeneration({
        model,
        cwd: config.projectDir,
        instructionsPath: initResult.instructionsPath,
        outputPath: config.outputPath,
        stateDir: initResult.stateDir,
        abortSignal: signal,
      });
    })();

  // Active step wins over done (revisiting shows ❯), except in the final
  // done state where everything completed shows ✓.
  const stepStatus = (id: UiStep) => {
    if (id === "generate") {
      if (summary) return "done";
      return result ? "current" : "pending";
    }
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
                clearSources(config.stateDir);
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
            // The run log stays on screen after the run so the completed
            // actions remain visible above the summary.
            <>
              <Box
                flexDirection="column"
                marginTop={1}
                paddingX={1}
                borderStyle="round"
                borderColor="gray"
              >
                <Generate
                  start={startGeneration(result)}
                  done={summary !== null}
                  onDone={setSummary}
                />
              </Box>
              {summary ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    Successfully initialized wiki at {config.outputPath}
                  </Text>
                  <Text dimColor>run "infrawiki update" to update</Text>
                  {summary.error ? (
                    <Text color="red">generation failed: {summary.error}</Text>
                  ) : null}
                </Box>
              ) : (
                <Text dimColor>{GENERATE_HINT}</Text>
              )}
            </>
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
                          init: { step: "sources" },
                        });
                        setDetails((d) => ({ ...d, model: detail }));
                        setActive("sources");
                      }}
                    />
                  ) : (
                    <Text dimColor>Loading model catalog…</Text>
                  ))}
                {active === "sources" && (
                  <Sources
                    stateDir={config.stateDir}
                    api={awsApi}
                    onHint={setSourcesHint}
                    onBack={() => setActive("model")}
                    onContinue={(detail) => {
                      config.update({ init: { step: "output-dir" } });
                      setDetails((d) => ({ ...d, sources: detail }));
                      setActive("output-dir");
                    }}
                  />
                )}
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
                {active === "sources"
                  ? sourcesHint
                  : `${STEP_HINTS[active]}${active === "model" ? "" : " · esc back"}`}
              </Text>
            </>
          )}
        </>
      )}
    </Box>
  );
}
