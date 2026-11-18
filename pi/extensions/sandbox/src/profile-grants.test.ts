import assert from "node:assert/strict";
import test from "node:test";
import { AgentMode } from "../../lib/agent-mode.ts";
import { exact, glob, tree } from "../../lib/path-permission-rules.ts";
import type { OnceGrant } from "../../lib/path-permissions.ts";
import { profileEnvironment, withoutRepositoryWrites } from "./profile-grants.ts";
import type { ProfileInputs } from "./profile-grants.ts";
import { emptyProfileDefinition, profileFingerprint } from "./profiles.ts";
import type { Profile } from "./profiles.ts";

const inputs: ProfileInputs = { agentMode: AgentMode.Execution, repositoryRoot: "/work/repo", stateDirectory: "/home/u/.pi/agent/sandbox-state", homeDirectory: "/home/u", instance: "instance-1" };

test("execution mode keeps every write grant", () => {
  // arrange
  const grants: OnceGrant[] = [{ mode: "write", selector: tree("/work") }, { mode: "write", selector: tree("/work/repo/out") }];

  // act
  const kept = withoutRepositoryWrites(grants, "/work/repo", AgentMode.Execution);

  // assert
  assert.deepEqual(kept, grants);
});

test("planning and exploring drop writes that contain or lie inside the repository", () => {
  // arrange
  const outside: OnceGrant = { mode: "write", selector: tree("/cache") };
  const read: OnceGrant = { mode: "read", selector: tree("/work") };
  const grants: OnceGrant[] = [
    { mode: "write", selector: tree("/work") },
    { mode: "write", selector: tree("/work/repo/out") },
    { mode: "write", selector: exact("/work/repo") },
    { mode: "write", selector: glob("/work/repo", "*.log") },
    outside,
    read,
  ];

  // act
  const kept = [AgentMode.Planning, AgentMode.Exploring].map((mode) => withoutRepositoryWrites(grants, "/work/repo", mode));

  // assert
  assert.deepEqual(kept, [[outside, read], [outside, read]]);
});

test("the environment puts shim directories first and sets the three variables", () => {
  // arrange
  const profiles: Profile[] = [
    { name: "a", ...emptyProfileDefinition(), path: ["~/shims/a"] },
    { name: "b", ...emptyProfileDefinition(), path: ["/opt/shims/b"] },
  ];

  // act
  const environment = profileEnvironment({ PATH: "/usr/bin:/bin", HOME: "/home/u" }, profiles, inputs);

  // assert
  assert.equal(environment.PATH, "/home/u/shims/a:/opt/shims/b:/usr/bin:/bin");
  assert.equal(environment.PI_SANDBOX_PROFILE_FINGERPRINT, profileFingerprint(profiles));
  assert.equal(environment.PI_SANDBOX_INSTANCE, "instance-1");
  assert.equal(environment.PI_SANDBOX_STATE_DIR, "/home/u/.pi/agent/sandbox-state");
  assert.equal(environment.HOME, "/home/u");
});
