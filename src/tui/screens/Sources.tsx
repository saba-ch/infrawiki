import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { AwsApi } from "../../connectors/aws";
import {
  formatSourcesDetail,
  listSources,
  type Source,
  sourceLabel,
  sourceSummary,
} from "../../sources";
import { Select } from "../components/Select";
import { AwsConnector } from "./AwsConnector";

type Phase = { id: "list" } | { id: "aws"; existing?: Source };

interface Props {
  stateDir: string;
  api: AwsApi;
  onContinue: (detail: string) => void;
  onBack: () => void;
  /** Reports the keys valid right now for the App's single hint line. */
  onHint: (hint: string) => void;
}

export function Sources({ stateDir, api, onContinue, onBack, onHint }: Props) {
  const [phase, setPhase] = useState<Phase>({ id: "list" });
  const [sources, setSources] = useState(() => listSources(stateDir));
  const [continueError, setContinueError] = useState<string>();

  useInput((_input, key) => {
    if (key.escape && phase.id === "list") onBack();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: onHint is a stable prop
  useEffect(() => {
    if (phase.id === "list") onHint("↑↓ choose · enter select · esc back");
  }, [phase.id]);

  if (phase.id === "aws") {
    return (
      <AwsConnector
        api={api}
        stateDir={stateDir}
        existing={phase.existing}
        onExit={() => {
          // The connector persists as it goes; re-read once on return.
          setSources(listSources(stateDir));
          setContinueError(undefined);
          setPhase({ id: "list" });
        }}
        onHint={onHint}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Sources</Text>
      {continueError ? <Text color="red">{continueError}</Text> : null}
      <Select
        options={[
          ...sources.map((source) => ({
            label: sourceLabel(source),
            value: source.accountId,
            hint: sourceSummary(source),
          })),
          { label: "Add AWS", value: "add-aws" },
          { label: "Continue", value: "continue" },
        ]}
        onSelect={(value) => {
          if (value === "continue") {
            const incomplete = sources.find(
              (source) => source.type === "aws" && source.regions.length === 0,
            );
            if (incomplete) {
              setContinueError(
                `select at least one region for ${sourceLabel(incomplete)}`,
              );
              return;
            }
            onContinue(formatSourcesDetail(sources));
          } else if (value === "add-aws") {
            setContinueError(undefined);
            setPhase({ id: "aws" });
          } else {
            const existing = sources.find((s) => s.accountId === value);
            if (existing) {
              setContinueError(undefined);
              setPhase({ id: "aws", existing });
            }
          }
        }}
      />
    </Box>
  );
}
