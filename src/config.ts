import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

const InitCheckpointSchema = z.object({
  step: z.enum(["model", "output-dir", "instructions"]),
});

const ProviderOptionsSchema = z.object({
  resourceName: z.string().optional(), // azure
  baseURL: z.string().optional(), // custom openai-compatible endpoints
});

const ConfigSchema = z.object({
  outputDir: z.string().default("infrawiki"),
  // Absent = global state dir under ~/.infrawiki/projects/<project-id>.
  // Set to e.g. ".infrawiki" to keep state local to the project.
  stateDir: z.string().optional(),
  // "provider/model-id", split on the first slash. Secrets live in the state
  // dir's auth.json, never here.
  model: z.string().optional(),
  providers: z.record(z.string(), ProviderOptionsSchema).optional(),
  initialized: z.boolean().default(false),
  init: InitCheckpointSchema.optional(),
});

type ConfigData = z.infer<typeof ConfigSchema>;
export type InitCheckpoint = z.infer<typeof InitCheckpointSchema>;
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;

export interface InitResult {
  stateDir: string;
  instructionsPath: string;
}

export const DEFAULT_INSTRUCTIONS = `# Wiki instructions

These instructions guide how InfraWiki generates and maintains this wiki.

- Document each connected source account and its resources.
- Group pages by service, then by resource.
- Keep pages concise and cross-link related resources.
- On updates, only rewrite pages affected by the delta.

Add project-specific guidance below.
`;

export class Config {
  static readonly FILE = "infrawiki.json";

  readonly id: string;

  private constructor(
    readonly projectDir: string,
    private readonly home: string,
    private data: ConfigData,
  ) {
    const abs = resolve(projectDir);
    const slug = basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8);
    this.id = `${slug}-${hash}`;
  }

  static load(projectDir: string, home: string = homedir()): Config {
    const path = join(projectDir, Config.FILE);
    const data = existsSync(path)
      ? ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : ConfigSchema.parse({});
    return new Config(projectDir, home, data);
  }

  get initialized(): boolean {
    return this.data.initialized;
  }

  get outputDir(): string {
    return this.data.outputDir;
  }

  get outputPath(): string {
    return resolve(this.projectDir, this.data.outputDir);
  }

  get checkpoint(): InitCheckpoint | undefined {
    return this.data.init;
  }

  get model(): string | undefined {
    return this.data.model;
  }

  get providers(): Record<string, ProviderOptions> | undefined {
    return this.data.providers;
  }

  get stateDir(): string {
    if (this.data.stateDir) return resolve(this.projectDir, this.data.stateDir);
    return join(this.home, ".infrawiki", "projects", this.id);
  }

  get configPath(): string {
    return join(this.projectDir, Config.FILE);
  }

  update(patch: Partial<ConfigData>): void {
    this.data = { ...this.data, ...patch };
    writeFileSync(this.configPath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  initialize(instructions: string): InitResult {
    this.update({ initialized: true, init: undefined });

    const stateDir = this.stateDir;
    mkdirSync(join(stateDir, "sources"), { recursive: true, mode: 0o700 });
    const authPath = join(stateDir, "auth.json");
    // Re-init must not clobber stored credentials.
    if (!existsSync(authPath)) writeFileSync(authPath, "{}\n", { mode: 0o600 });

    const outputPath = this.outputPath;
    mkdirSync(outputPath, { recursive: true });
    const instructionsPath = join(outputPath, "instructions.md");
    writeFileSync(instructionsPath, instructions);

    return { stateDir, instructionsPath };
  }
}
