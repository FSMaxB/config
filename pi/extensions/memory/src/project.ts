import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";

export interface Project {
  root: string;
  hash: string;
}

export function resolveProject(cwd: string): Project {
  const canonical = realpathSync(cwd);
  let root = canonical;
  for (let current = canonical; ; current = dirname(current)) {
    if (existsSync(join(current, ".jj")) || existsSync(join(current, ".git"))) {
      root = current;
      break;
    }
    if (current === parse(current).root) break;
  }
  return { root, hash: createHash("sha256").update(root).digest("hex") };
}
