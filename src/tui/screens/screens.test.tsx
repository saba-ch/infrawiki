import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { OutputDir } from "./OutputDir";

// Guards the `value.trim() || defaultValue` fallback in OutputDir: clearing
// the prefilled value and submitting must not produce an empty output dir.
test("OutputDir falls back to the default when input is cleared", async () => {
  const submitted: string[] = [];
  const { stdin } = render(
    <OutputDir
      defaultValue="infrawiki"
      onSubmit={(value) => submitted.push(value)}
    />,
  );
  await Bun.sleep(10);
  stdin.write("\x7f".repeat("infrawiki".length));
  await Bun.sleep(10);
  stdin.write("\r");
  await Bun.sleep(10);
  expect(submitted).toEqual(["infrawiki"]);
});
