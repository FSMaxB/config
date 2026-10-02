import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { glob, tree } from "../../lib/path-permission-rules.ts";
import type { EffectivePolicy } from "../../lib/path-permissions.ts";
import { filesystemConfig, secretPaths, type PolicyOptions } from "./policy.ts";

const HOME = "/Users/max";

function options(overrides: Partial<PolicyOptions> = {}): PolicyOptions {
  return { platform: "darwin", homeDirectory: HOME, toolchainRead: [`${HOME}/.cargo`], extraDenyRead: [], ...overrides };
}

function policy(overrides: { read?: Partial<EffectivePolicy["read"]>; write?: Partial<EffectivePolicy["write"]> } = {}): EffectivePolicy {
  return {
    read: { allow: [tree(`${HOME}/repo`)], deny: [], protected: [], ...overrides.read },
    write: { allow: [tree(`${HOME}/repo`)], deny: [], protected: [], ...overrides.write },
  };
}

test("the repository tree is readable and writable", () => {
  // arrange
  const effective = policy();

  // act
  const config = filesystemConfig(effective, options());

  // assert
  assert.ok(config.allowRead?.includes(`${HOME}/repo`));
  assert.deepEqual(config.allowWrite, [`${HOME}/repo`]);
});

test("the home directory and the user roots are unreadable by default", () => {
  // arrange
  const effective = policy();

  // act
  const darwin = filesystemConfig(effective, options({ platform: "darwin" }));
  const linux = filesystemConfig(effective, options({ platform: "linux", homeDirectory: "/home/max" }));

  // assert
  assert.ok(darwin.denyRead.includes(HOME));
  assert.ok(darwin.denyRead.includes("/Users"));
  assert.ok(linux.denyRead.includes("/home/max"));
  assert.ok(linux.denyRead.includes("/home"));
  assert.ok(linux.denyRead.includes("/root"));
});

test("secrets stay denied even when a grant allows the whole home directory", () => {
  // arrange
  const effective = policy({ read: { allow: [tree(HOME)] }, write: { allow: [tree(HOME)] } });

  // act
  const config = filesystemConfig(effective, options());

  // assert
  assert.ok(config.allowRead?.includes(HOME));
  for (const secret of secretPaths(HOME)) {
    assert.ok(config.denyRead.includes(secret), `${secret} must be denied for reads`);
    assert.ok(config.denyWrite.includes(secret), `${secret} must be denied for writes`);
  }
});

test("protected and denied selectors land in denyWrite", () => {
  // arrange
  const effective = policy({ write: { protected: [tree(`${HOME}/repo/pi/extensions`)], deny: [tree(`${HOME}/repo/vendor`)] } });

  // act
  const config = filesystemConfig(effective, options());

  // assert
  assert.ok(config.denyWrite.includes(`${HOME}/repo/pi/extensions`));
  assert.ok(config.denyWrite.includes(`${HOME}/repo/vendor`));
});

test("read denies from the rules are passed through", () => {
  // arrange
  const effective = policy({ read: { deny: [tree(`${HOME}/repo/private`)] } });

  // act
  const config = filesystemConfig(effective, options({ extraDenyRead: ["/extra"] }));

  // assert
  assert.ok(config.denyRead.includes(`${HOME}/repo/private`));
  assert.ok(config.denyRead.includes("/extra"));
});

test("a glob write allow is kept on darwin and dropped on linux", () => {
  // arrange
  const effective = policy({ write: { allow: [tree(`${HOME}/repo`), glob(`${HOME}/notes`, "*.md")] } });

  // act
  const darwin = filesystemConfig(effective, options({ platform: "darwin" }));
  const linux = filesystemConfig(effective, options({ platform: "linux" }));

  // assert
  assert.ok(darwin.allowWrite.includes(`${HOME}/notes/*.md`));
  assert.deepEqual(linux.allowWrite, [`${HOME}/repo`]);
});

test("a glob write deny becomes its base directory on linux", () => {
  // arrange
  const effective = policy({ write: { protected: [glob(`${HOME}/.pi/agent`, "*.json")] } });

  // act
  const darwin = filesystemConfig(effective, options({ platform: "darwin" }));
  const linux = filesystemConfig(effective, options({ platform: "linux" }));

  // assert
  assert.ok(darwin.denyWrite.includes(`${HOME}/.pi/agent/*.json`));
  assert.ok(linux.denyWrite.includes(`${HOME}/.pi/agent`));
});

test("a plan-mode policy without the repository allows no repository write", () => {
  // arrange
  const effective = policy({ write: { allow: [tree(`${HOME}/.pi/agent/plans`)] } });

  // act
  const config = filesystemConfig(effective, options());

  // assert
  assert.deepEqual(config.allowWrite, [`${HOME}/.pi/agent/plans`]);
  assert.ok(config.allowRead?.includes(`${HOME}/repo`));
});

test("the sandbox-runtime package stays readable under a denied home directory", () => {
  // arrange
  const effective = policy();

  // act
  const config = filesystemConfig(effective, options({ platform: "linux" }));

  // assert
  const runtimeDirectory = config.allowRead?.find((path) => path.endsWith("/node_modules/@anthropic-ai/sandbox-runtime"));
  assert.ok(runtimeDirectory, "the sandbox-runtime package directory must be read-allowed");
  assert.ok(existsSync(join(runtimeDirectory, "vendor", "seccomp")), `${runtimeDirectory} must contain the vendored seccomp helper`);
});
