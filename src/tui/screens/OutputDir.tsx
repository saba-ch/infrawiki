import { Box, Text } from "ink";
import { TextInput } from "../components/TextInput";

interface Props {
  defaultValue: string;
  onSubmit: (outputDir: string) => void;
}

export const OUTPUT_DIR_HINT = "enter confirm";

export function OutputDir({ defaultValue, onSubmit }: Props) {
  return (
    <Box flexDirection="column">
      <Text bold>Where should the wiki be generated?</Text>
      <Box>
        <Text dimColor>Directory: </Text>
        <TextInput
          defaultValue={defaultValue}
          placeholder={defaultValue}
          onSubmit={(value) => onSubmit(value.trim() || defaultValue)}
        />
      </Box>
    </Box>
  );
}
