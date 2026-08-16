import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { runGeneration } from "../agent/loop";
import { AuthStore } from "../auth/store";
import type { Catalog } from "../catalog";
import type { Config, InitCheckpoint, InitResult } from "../config";
import { type AwsApi, createAwsApi } from "../connectors/aws";
import { createModel, type ProviderModel, splitModelId } from "../model";
import {
  clearSources,
  formatSourcesDetail,
  listSources,
  markProcessed,
  syncSources,
} from "../sources";
import { GENERATE_HINT, Generate } from "./screens/Generate";
import { INSTRUCTIONS_HINT, Instructions } from "./screens/Instructions";
import { MODEL_HINT, Model } from "./screens/Model";
import { OUTPUT_DIR_HINT, OutputDir } from "./screens/OutputDir";
import { Sources } from "./screens/Sources";
import { Welcome } from "./screens/Welcome";

type StepId = InitCheckpoint["step"];
type UiStep = StepId | "generate";

const INIT_STEPS: { id: UiStep; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "sources", label: "Sources" },
  { id: "output-dir", label: "Output" },
  { id: "instructions", label: "Instructions" },
  { id: "generate", label: "Generate" },
];

const UPDATE_STEPS: { id: UiStep; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "generate", label: "Update" },
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
  /** Update runs skip setup steps and re-run the agent against the delta. */
  mode?: "init" | "update";
  /** Test seam: skips createModel so tests can inject a mock model. */
  model?: ProviderModel;
  /** Test seam: fake AWS client layer for the sources step. */
  awsApi?: AwsApi;
}

export function App({
  config,
  catalog: catalogPromise,
  mode = "init",
  model: modelOverride,
  awsApi: awsApiOverride,
}: Props) {
  const [gated, setGated] = useState(
    mode === "init" && (config.initialized || config.checkpoint !== undefined),
  );
  const [active, setActive] = useState<StepId>(
    mode === "update" ? "sources" : (config.checkpoint?.step ?? "model"),
  );
  const [details, setDetails] = useState<Partial<Record<UiStep, string>>>(() =>
    mode === "update" ? {} : seedDetails(config),
  );
  const [result, setResult] = useState<InitResult | null>(null);
  // summary with result === null means init finished without a generation run
  // (no sources connected) — the skip branch is the only other setSummary site.
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
      const { provider, model: modelName } = splitModelId(
        config.model as string,
      );
      return runGeneration({
        model,
        cwd: config.projectDir,
        instructionsPath: initResult.instructionsPath,
        outputPath: config.outputPath,
        stateDir: initResult.stateDir,
        mode: mode === "update" ? "update" : "generate",
        // Unknown window (catalog unavailable) just disables compaction.
        contextWindow: catalog?.[provider]?.models[modelName]?.limit?.context,
        abortSignal: signal,
      });
    })();

  // The final summary's four (mode, ran-a-generation) outcomes, flattened.
  const heading =
    mode === "update"
      ? result
        ? `Updated wiki at ${config.outputPath}`
        : "Nothing to update"
      : `Successfully initialized wiki at ${config.outputPath}`;
  const hint = !result
    ? `no sources connected — run "infrawiki ${mode}" again to connect one and generate the wiki`
    : mode === "init"
      ? 'run "infrawiki update" to update'
      : undefined;

  // Active step wins over done (revisiting shows ❯), except in the final
  // done state where everything completed shows ✓.
  const stepStatus = (id: UiStep) => {
    if (id === "generate") {
      if (!result) return "pending";
      return summary ? "done" : "current";
    }
    if (!result && !summary && id === active) return "current";
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
            {(mode === "update" ? UPDATE_STEPS : INIT_STEPS).map((step) => {
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
            <Box
              flexDirection="column"
              marginTop={1}
              paddingX={1}
              borderStyle="round"
              borderColor="gray"
            >
              <Generate
                sync={(signal, onProgress) =>
                  syncSources(awsApi, config.stateDir, {
                    signal,
                    onProgress,
                  })
                }
                start={startGeneration(result)}
                done={summary !== null}
                onDone={(outcome) => {
                  // The wiki now documents the latest snapshots; the next
                  // update diffs against them.
                  if (!outcome.error) markProcessed(config.stateDir);
                  setSummary(outcome);
                }}
              />
            </Box>
          ) : null}
          {summary ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>{heading}</Text>
              {hint ? <Text dimColor>{hint}</Text> : null}
              {summary.error ? (
                <Text color="red">generation failed: {summary.error}</Text>
              ) : null}
            </Box>
          ) : result ? (
            <Text dimColor>{GENERATE_HINT}</Text>
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
                    focusContinue={mode === "update"}
                    onHint={setSourcesHint}
                    onBack={() =>
                      mode === "update" ? exit() : setActive("model")
                    }
                    onContinue={(detail) => {
                      setDetails((d) => ({ ...d, sources: detail }));
                      if (mode === "update") {
                        // No checkpointing: the update wizard is two cheap
                        // steps, redoing them costs nothing.
                        if (listSources(config.stateDir).length === 0)
                          setSummary({});
                        else
                          setResult({
                            stateDir: config.stateDir,
                            instructionsPath: config.instructionsPath,
                          });
                        return;
                      }
                      config.update({ init: { step: "output-dir" } });
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
                      const initResult = config.initialize(instructions);
                      // Nothing to generate from without a source; finish init
                      // and point the user at connecting one.
                      if (listSources(config.stateDir).length === 0)
                        setSummary({});
                      else setResult(initResult);
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
