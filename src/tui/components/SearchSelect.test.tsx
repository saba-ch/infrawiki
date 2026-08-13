import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { SearchSelect } from "./SearchSelect";

const OPTIONS = [
  { label: "Anthropic", value: "anthropic" },
  { label: "OpenAI", value: "openai" },
  { label: "Azure", value: "azure", hint: "resource + API key" },
];

test("typing filters and enter selects the highlighted match", async () => {
  const selected: string[] = [];
  const { stdin, lastFrame } = render(
    <SearchSelect options={OPTIONS} onSelect={(v) => selected.push(v)} />,
  );
  await Bun.sleep(10);
  stdin.write("azu");
  await Bun.sleep(10);
  expect(lastFrame()).toContain("Azure");
  expect(lastFrame()).not.toContain("OpenAI");
  stdin.write("\r");
  await Bun.sleep(10);
  expect(selected).toEqual(["azure"]);
});

test("arrow keys move the highlight", async () => {
  const selected: string[] = [];
  const { stdin } = render(
    <SearchSelect options={OPTIONS} onSelect={(v) => selected.push(v)} />,
  );
  await Bun.sleep(10);
  stdin.write("\x1b[B"); // down
  await Bun.sleep(10);
  stdin.write("\r");
  await Bun.sleep(10);
  expect(selected).toEqual(["openai"]);
});

test("no matches renders a hint instead of selecting", async () => {
  const selected: string[] = [];
  const { stdin, lastFrame } = render(
    <SearchSelect options={OPTIONS} onSelect={(v) => selected.push(v)} />,
  );
  await Bun.sleep(10);
  stdin.write("zzz");
  await Bun.sleep(10);
  expect(lastFrame()).toContain("no matches");
  stdin.write("\r");
  await Bun.sleep(10);
  expect(selected).toEqual([]);
});
