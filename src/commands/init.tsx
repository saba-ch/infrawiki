import { render } from "ink";
import { Config } from "../config";
import { App } from "../tui/App";

export async function runInit(): Promise<void> {
  const config = Config.load(process.cwd());
  const { waitUntilExit } = render(<App config={config} />);
  await waitUntilExit();
}
