import { render } from "ink";
import { loadCatalog } from "../catalog";
import { Config } from "../config";
import { App } from "../tui/App";

export async function runInit(): Promise<void> {
  const config = Config.load(process.cwd());
  // Kick off the fetch without awaiting; the model step shows a loading state.
  const catalog = loadCatalog();
  const { waitUntilExit } = render(<App config={config} catalog={catalog} />);
  await waitUntilExit();
}
