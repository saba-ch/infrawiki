import { Box, Text } from "ink";
import { Select } from "../components/Select";

interface Props {
  initialized: boolean;
  onStart: (mode: "fresh" | "resume") => void;
  onCancel: () => void;
}

// Only rendered when there is something to decide: an already-initialized
// project or an unfinished setup. Fresh projects go straight to the steps.
export function Welcome({ initialized, onStart, onCancel }: Props) {
  const message = initialized
    ? "This project is already initialized."
    : "Found an unfinished setup.";
  const options = initialized
    ? [
        { label: "Reconfigure it", value: "fresh" },
        { label: "Cancel", value: "cancel" },
      ]
    : [
        { label: "Resume where I left off", value: "resume" },
        { label: "Start over", value: "fresh" },
      ];

  return (
    <Box flexDirection="column">
      <Text color="yellow">{message}</Text>
      <Select
        options={options}
        onSelect={(value) =>
          value === "cancel" ? onCancel() : onStart(value as "fresh" | "resume")
        }
      />
    </Box>
  );
}
