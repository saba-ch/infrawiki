import { IndexState, IndexType } from "@aws-sdk/client-resource-explorer-2";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import {
  type AwsApi,
  type AwsProfile,
  type AwsSource,
  describeAwsError,
  type IndexInfo,
  listAwsProfiles,
  loadRegionRows,
  type RegionRow,
} from "../../connectors/aws";
import { saveSource } from "../../sources";
import { SearchSelect } from "../components/SearchSelect";
import { Select } from "../components/Select";
import { useSpinner } from "../components/useSpinner";

const CHOOSE_HINT = "↑↓ choose · enter select · esc back";
const REGIONS_HINT = "tab select · → index actions · enter continue · esc back";

type Phase =
  | { id: "profiles" }
  | { id: "validating"; profile: string }
  | { id: "auth-error"; profile: string; message: string; hint?: string }
  | { id: "regions"; source: AwsSource }
  | { id: "region-action"; source: AwsSource; region: string };

interface Props {
  api: AwsApi;
  stateDir: string;
  /** Entering from an already-configured source jumps straight to regions. */
  existing?: AwsSource;
  onExit: () => void;
  /** Reports the keys valid in the current phase for the single hint line. */
  onHint: (hint: string) => void;
  /** Test seam: index state poll interval. */
  pollMs?: number;
}

const transitional = (index?: RegionRow["index"]) =>
  index?.state === IndexState.CREATING || index?.state === IndexState.UPDATING;

const active = (index?: RegionRow["index"]) =>
  index?.state === IndexState.ACTIVE;

function rowHint(row: RegionRow, selected: boolean, spinner: string): string {
  const index = row.index;
  const status = (() => {
    if (!index) return "no index · → enable";
    switch (index.state) {
      case undefined:
        return `${spinner} checking…`;
      case IndexState.CREATING:
        return `${spinner} creating…`;
      case IndexState.UPDATING:
        return `${spinner} promoting…`;
      case IndexState.ACTIVE:
        return index.type === IndexType.AGGREGATOR
          ? "aggregator"
          : "local index";
      default:
        return index.state.toLowerCase();
    }
  })();
  return selected ? `${status} · ✓ selected` : status;
}

export function AwsConnector({
  api,
  stateDir,
  existing,
  onExit,
  onHint,
  pollMs = 5000,
}: Props) {
  const [phase, setPhase] = useState<Phase>(
    existing ? { id: "regions", source: existing } : { id: "profiles" },
  );
  const [profiles, setProfiles] = useState<AwsProfile[]>();
  const [rows, setRows] = useState<RegionRow[]>();
  const [regionsError, setRegionsError] = useState<{
    message: string;
    hint?: string;
  }>();
  const [actionError, setActionError] = useState<string>();

  const pending = (rows ?? [])
    .filter((row) => transitional(row.index))
    .map((row) => row.region);
  const pendingKey = pending.join(",");

  const setRowIndex = (region: string, index: IndexInfo | undefined) =>
    setRows((current) =>
      current?.map((row) => (row.region === region ? { region, index } : row)),
    );

  const toggleRegion = (
    source: AwsSource,
    region: string,
    index: IndexType,
  ) => {
    const regions = source.regions.some((r) => r.name === region)
      ? source.regions.filter((r) => r.name !== region)
      : [...source.regions, { name: region, index }].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
    const updated = { ...source, regions };
    saveSource(stateDir, updated);
    setPhase({ id: "regions", source: updated });
  };

  const startCreate = (source: AwsSource, region: string) => {
    setActionError(undefined);
    setRowIndex(region, {
      arn: "",
      type: IndexType.LOCAL,
      state: IndexState.CREATING,
    });
    api.createIndex(source.profile, region).catch((err) => {
      if ((err as Error).name === "ConflictException") {
        // Index already exists (made elsewhere) — adopt it.
        api
          .getIndex(source.profile, region)
          .then((info) => setRowIndex(region, info));
      } else {
        setRowIndex(region, undefined);
        setActionError(describeAwsError(err, source.profile).message);
      }
    });
  };

  // Only reachable from an ACTIVE local index, so revert restores ACTIVE.
  const startPromote = (
    source: AwsSource,
    region: string,
    index: { arn: string; type: IndexType },
  ) => {
    setActionError(undefined);
    setRowIndex(region, { ...index, state: IndexState.UPDATING });
    api.promoteIndex(source.profile, region, index.arn).catch((err) => {
      setRowIndex(region, { ...index, state: IndexState.ACTIVE });
      setActionError(
        (err as Error).name === "ConflictException"
          ? "another region is already the aggregator — demote it first (24h cooldown applies)"
          : describeAwsError(err, source.profile).message,
      );
    });
  };

  useInput((_input, key) => {
    if (!key.escape) return;
    switch (phase.id) {
      case "profiles":
        onExit();
        break;
      case "validating":
      case "auth-error":
        setPhase({ id: "profiles" });
        break;
      case "regions":
        onExit();
        break;
      case "region-action":
        setPhase({ id: "regions", source: phase.source });
        break;
    }
  });

  useEffect(() => {
    if (phase.id === "profiles" && !profiles)
      listAwsProfiles().then(setProfiles);
  }, [phase.id, profiles]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: api/stateDir are stable props
  useEffect(() => {
    if (phase.id !== "validating") return;
    const profile = phase.profile;
    let stale = false;
    api.callerIdentity(profile).then(
      ({ accountId }) => {
        if (stale) return;
        const source: AwsSource = {
          type: "aws",
          profile,
          accountId,
          regions: [],
          addedAt: new Date().toISOString(),
        };
        saveSource(stateDir, source);
        setPhase({ id: "regions", source });
      },
      (err) => {
        if (stale) return;
        const { message, hint } = describeAwsError(err, profile);
        setPhase({ id: "auth-error", profile, message, hint });
      },
    );
    return () => {
      stale = true;
    };
  }, [phase]);

  // Keyed on the profile alone so the progressive stream survives re-renders
  // from its own updates and regions <-> region-action hops.
  const streamProfile =
    phase.id === "regions" || phase.id === "region-action"
      ? phase.source.profile
      : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is a stable prop
  useEffect(() => {
    if (!streamProfile) return;
    let stale = false;
    loadRegionRows(api, streamProfile, (loaded) => {
      if (!stale) setRows(loaded);
    }).catch((err) => {
      if (!stale) setRegionsError(describeAwsError(err, streamProfile));
    });
    return () => {
      stale = true;
    };
  }, [streamProfile]);

  // Poll only transitional regions; the live API is the pending-op record, so
  // nothing is persisted and quitting mid-operation is safe. Keyed on
  // streamProfile (not phase) so re-renders don't reset the interval.
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is a stable prop; pending matches pendingKey
  useEffect(() => {
    if (!pendingKey || !streamProfile) return;
    let stale = false;
    const timer = setInterval(async () => {
      for (const region of pending) {
        try {
          const info = await api.getIndex(streamProfile, region);
          if (stale) return;
          setRowIndex(region, info);
        } catch (err) {
          if (stale) return;
          setActionError(describeAwsError(err, streamProfile).message);
        }
        // Resource Explorer caps non-Search calls at 3/sec.
        await Bun.sleep(350);
      }
    }, pollMs);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [pendingKey, streamProfile, pollMs]);

  // A selected region's index type can change under it (promote to
  // aggregator); keep the persisted snapshot in step with live state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stateDir is a stable prop
  useEffect(() => {
    if (phase.id !== "regions" && phase.id !== "region-action") return;
    const source = phase.source;
    const regions = source.regions.map((selected) => {
      const index = rows?.find((row) => row.region === selected.name)?.index;
      return index?.state === IndexState.ACTIVE && index.type !== selected.index
        ? { ...selected, index: index.type }
        : selected;
    });
    if (regions.some((r, i) => r !== source.regions[i])) {
      const updated = { ...source, regions };
      saveSource(stateDir, updated);
      setPhase({ ...phase, source: updated });
    }
  }, [rows, phase]);

  const checking = (rows ?? []).some((row) => row.index?.state === undefined);
  // Only phases that actually render a spinner glyph keep the timer running.
  const spinning =
    phase.id === "validating" ||
    (phase.id === "regions" &&
      ((!rows && !regionsError) || checking || pending.length > 0));
  const spinner = useSpinner(spinning);

  const hint = (() => {
    switch (phase.id) {
      case "validating":
        return "esc back";
      case "regions":
        if (regionsError || !rows) return "esc back";
        return REGIONS_HINT;
      default:
        return CHOOSE_HINT;
    }
  })();
  // biome-ignore lint/correctness/useExhaustiveDependencies: onHint is a stable prop
  useEffect(() => {
    onHint(hint);
  }, [hint]);

  switch (phase.id) {
    case "profiles":
      if (!profiles) return <Text dimColor>Loading AWS profiles…</Text>;
      if (profiles.length === 0)
        return <Text color="yellow">No AWS profiles found in ~/.aws</Text>;
      return (
        <Box flexDirection="column">
          <Text bold>Pick an AWS profile</Text>
          <SearchSelect
            options={profiles.map((p) => ({
              value: p.name,
              label: p.name,
              hint: p.region,
            }))}
            onSelect={(name) => setPhase({ id: "validating", profile: name })}
          />
        </Box>
      );

    case "validating":
      return (
        <Text color="cyan">
          {spinner} Validating {phase.profile}…
        </Text>
      );

    case "auth-error":
      return (
        <Box flexDirection="column">
          <Text color="red">{phase.message}</Text>
          {phase.hint ? <Text dimColor>{phase.hint}</Text> : null}
          <Select
            options={[
              { label: "Retry", value: "retry" },
              { label: "Back", value: "back" },
            ]}
            onSelect={(value) =>
              setPhase(
                value === "retry"
                  ? { id: "validating", profile: phase.profile }
                  : { id: "profiles" },
              )
            }
          />
        </Box>
      );

    case "regions": {
      const { source } = phase;
      if (regionsError)
        return (
          <Box flexDirection="column">
            <Text color="red">{regionsError.message}</Text>
            {regionsError.hint ? (
              <Text dimColor>{regionsError.hint}</Text>
            ) : null}
          </Box>
        );
      if (!rows) return <Text color="cyan">{spinner} Loading regions…</Text>;
      return (
        <Box flexDirection="column">
          <Text bold>
            Regions · {source.profile} ({source.accountId})
          </Text>
          {actionError ? <Text color="red">{actionError}</Text> : null}
          <SearchSelect
            options={rows.map((row) => ({
              value: row.region,
              label: row.region,
              hint: rowHint(
                row,
                source.regions.some((r) => r.name === row.region),
                spinner,
              ),
            }))}
            // Enter moves forward once at least one region is selected.
            onSelect={() => {
              if (source.regions.length === 0) {
                setActionError("select at least one region first (tab)");
                return;
              }
              onExit();
            }}
            onTab={(region) => {
              const row = rows.find((r) => r.region === region);
              if (row?.index && active(row.index)) {
                setActionError(undefined);
                toggleRegion(source, region, row.index.type);
              }
            }}
            onRightArrow={(region) => {
              const row = rows.find((r) => r.region === region);
              if (!row) return;
              const promotable =
                active(row.index) && row.index?.type === IndexType.LOCAL;
              if (promotable || !row.index)
                setPhase({ id: "region-action", source, region });
            }}
          />
        </Box>
      );
    }

    case "region-action": {
      const { source, region } = phase;
      // Derived from rows so the menu tracks live state instead of a snapshot.
      const index = rows?.find((r) => r.region === region)?.index;
      const back = () => setPhase({ id: "regions", source });
      return (
        <Box flexDirection="column">
          <Text bold>{region}</Text>
          <Select
            options={[
              index?.state === IndexState.ACTIVE &&
              index.type === IndexType.LOCAL
                ? {
                    label: "Make aggregator",
                    value: "promote",
                    hint: "replicates every region's index here",
                  }
                : {
                    label: "Create index",
                    value: "create",
                    hint: "takes minutes to activate",
                  },
              { label: "Back", value: "back" },
            ]}
            onSelect={(value) => {
              if (value === "create") startCreate(source, region);
              else if (value === "promote" && index)
                startPromote(source, region, index);
              back();
            }}
          />
        </Box>
      );
    }
  }
}
