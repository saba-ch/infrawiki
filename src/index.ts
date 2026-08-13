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

program.action(() => {
  const config = Config.load(process.cwd());
  if (!config.initialized) {
    console.log("No wiki here yet. Run `infrawiki init` to get started.");
    return;
  }
  console.log(`wiki:  ${config.outputPath}`);
  console.log(`state: ${config.stateDir}`);
});

program.parse();
