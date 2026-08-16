import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openBrowser } from "../browser";
import { Config } from "../config";
import { generateVisualization } from "../visualize/generator";

export async function runVisualize(options: { open: boolean }): Promise<void> {
  const config = Config.load(process.cwd());
  if (!config.initialized) {
    console.error('No wiki here yet. Run "infrawiki init" first.');
    process.exitCode = 1;
    return;
  }
  try {
    const outPath = join(config.stateDir, "visualize.html");
    const stats = await generateVisualization(config.outputPath, outPath);
    console.log(
      `Wrote ${outPath} (${stats.concepts} concepts, ${stats.edges} edges)`,
    );
    if (options.open) openBrowser(pathToFileURL(outPath).href);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
