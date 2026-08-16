import { render } from "ink";
import { loadCatalog } from "../catalog";
import { Config } from "../config";
import { App } from "../tui/App";

export async function runUpdate(): Promise<void> {
  const config = Config.load(process.cwd());
  if (!config.initialized) {
    console.error('No wiki here yet. Run "infrawiki init" first.');
    process.exitCode = 1;
    return;
  }
  // Kick off the fetch without awaiting; still needed for createModel and the
  // compaction context window.
  const catalog = loadCatalog();
  const { waitUntilExit } = render(
    <App config={config} catalog={catalog} mode="update" />,
  );
  await waitUntilExit();
}
