import type { ToolSet } from "ai";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { findTool } from "./find";
import { grepTool } from "./grep";
import { lsTool } from "./ls";
import { readTool } from "./read";
import { writeTool } from "./write";

export function createTools(cwd: string): ToolSet {
  return {
    read: readTool(cwd),
    write: writeTool(cwd),
    edit: editTool(cwd),
    ls: lsTool(cwd),
    grep: grepTool(cwd),
    find: findTool(cwd),
    bash: bashTool(cwd),
  };
}
