import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TextInput } from "./TextInput";

// Guards the CONTROL_SEQUENCES sanitizer: Shift+Enter in a modifyOtherKeys
// terminal sends "\x1b[27;2;13~", which must not leak into the value.
test("Shift+Enter escape sequence is not inserted into the value", async () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    <TextInput onSubmit={(value) => submitted.push(value)} />,
  );
  await Bun.sleep(10);
  stdin.write("ab");
  await Bun.sleep(10);
  stdin.write("\x1b[27;2;13~");
  await Bun.sleep(10);
  expect(lastFrame()).not.toContain("27;2;13");
  stdin.write("c");
  await Bun.sleep(10);
  stdin.write("\r");
  await Bun.sleep(10);
  expect(submitted).toEqual(["abc"]);
});

// Guards the ctrl/meta early return: ink passes the plain letter through for
// ctrl combos (Ctrl+A arrives as input "a"), which must not be inserted.
test("ctrl combos do not insert their letter", async () => {
  const submitted: string[] = [];
  const { stdin } = render(
    <TextInput onSubmit={(value) => submitted.push(value)} />,
  );
  await Bun.sleep(10);
  stdin.write("x");
  await Bun.sleep(10);
  stdin.write("\x01"); // Ctrl+A
  await Bun.sleep(10);
  stdin.write("\r");
  await Bun.sleep(10);
  expect(submitted).toEqual(["x"]);
});

test("mask renders bullets, never the secret", async () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    <TextInput mask onSubmit={(value) => submitted.push(value)} />,
  );
  await Bun.sleep(10);
  stdin.write("sk-secret");
  await Bun.sleep(10);
  expect(lastFrame()).not.toContain("sk-secret");
  expect(lastFrame()).toContain("•".repeat(9));
  stdin.write("\r");
  await Bun.sleep(10);
  expect(submitted).toEqual(["sk-secret"]);
});

test("typing, backspace, and submit work", async () => {
  const submitted: string[] = [];
  const { stdin } = render(
    <TextInput onSubmit={(value) => submitted.push(value)} />,
  );
  await Bun.sleep(10);
  stdin.write("wiki");
  await Bun.sleep(10);
  stdin.write("\x7f"); // backspace -> "wik"
  await Bun.sleep(10);
  stdin.write("is");
  await Bun.sleep(10);
  stdin.write("\r");
  await Bun.sleep(10);
  expect(submitted).toEqual(["wikis"]);
});

test("cmd/alt+backspace clears the whole line", async () => {
  const submitted: string[] = [];
  const { stdin } = render(
    <TextInput onSubmit={(value) => submitted.push(value)} />,
  );
  await Bun.sleep(10);
  stdin.write("infrawiki");
  await Bun.sleep(10);
  stdin.write("\x1b\x7f"); // meta+backspace
  await Bun.sleep(10);
  stdin.write("wiki");
  await Bun.sleep(10);
  stdin.write("\x15"); // Ctrl+U
  await Bun.sleep(10);
  stdin.write("docs");
  await Bun.sleep(10);
  stdin.write("\r");
  await Bun.sleep(10);
  expect(submitted).toEqual(["docs"]);
});
