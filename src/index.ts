#!/usr/bin/env bun
import { Command } from "commander";
import pkg from "../package.json";
import { Config } from "./config";

const program = new Command();

program.name("infrawiki").description(pkg.description).version(pkg.version);

program
  .command("init")
  .description("Initialize a new wiki in the current directory")
  .action(async () => {
    const { runInit } = await import("./commands/init");
    await runInit();
  });

program
  .command("update")
  .description("Update the wiki from the sources' current state")
  .action(async () => {
    const { runUpdate } = await import("./commands/update");
    await runUpdate();
  });

program
  .command("visualize")
  .description("Render the wiki as an interactive graph and open it")
  .option("--no-open", "do not open the browser automatically")
  .action(async (opts: { open: boolean }) => {
    const { runVisualize } = await import("./commands/visualize");
    await runVisualize({ open: opts.open });
  });

program.action(() => {
  const config = Config.load(process.cwd());
  if (!config.initialized) {
    console.log("No wiki here yet. Run `infrawiki init` to get started.");
    return;
  }
  console.log(`wiki:  ${config.outputPath}`);
  console.log(`state: ${config.stateDir}`);
  if (config.model) console.log(`model: ${config.model}`);
});

program.parse();
