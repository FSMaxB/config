// Overrides the built-in read/write/edit tools with the hashline variants (see
// lib/hashline.ts and lib/hashline-tools.ts). This deliberately overrides built-ins, which pi
// warns about once per tool at startup — expected, not a failure. Set PI_HASHLINE=0 to restore
// the stock tools with no other code changes.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createHashlineEditToolDefinition,
  createHashlineReadToolDefinition,
  createHashlineWriteToolDefinition,
} from "./lib/hashline-tools.ts";
import { registerToolWithGuidelines } from "./lib/register-tool.ts";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_HASHLINE === "0") return;
  const cwd = process.cwd();

  registerToolWithGuidelines(pi, createHashlineReadToolDefinition(cwd));
  registerToolWithGuidelines(pi, createHashlineWriteToolDefinition(cwd));
  registerToolWithGuidelines(pi, createHashlineEditToolDefinition(cwd));
}
