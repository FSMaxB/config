import assert from "node:assert/strict";
import test from "node:test";
import { floatingPaneCommands, shellQuote } from "./panes.ts";
import {
  advanceQuiet,
  formatComments,
  pickNewSession,
  quietElapsed,
  type SessionEntry,
  type TuicrComment,
} from "./tuicr-session.ts";

function entry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    slug: "owner/repo@main/worktree",
    kind: "local",
    path: "/tmp/session.json",
    updated_at: "2026-05-22T17:20:00Z",
    comment_count: 0,
    active: true,
    ...overrides,
  };
}

function comment(overrides: Partial<TuicrComment>): TuicrComment {
  return {
    id: "79c9b3e1",
    location: "src/main.rs:42",
    comment_type: "none",
    lifecycle_state: "local_draft",
    content: "Handle the empty case here.",
    ...overrides,
  };
}

test("pickNewSession ignores inactive entries and entries active before launch, picking the most recently updated of the rest", () => {
  // arrange
  const entries = [
    entry({ slug: "already-active", active: true, updated_at: "2026-05-22T17:00:00Z" }),
    entry({ slug: "inactive", active: false, updated_at: "2026-05-22T18:00:00Z" }),
    entry({ slug: "new-old", active: true, updated_at: "2026-05-22T17:10:00Z" }),
    entry({ slug: "new-newest", active: true, updated_at: "2026-05-22T17:30:00Z" }),
  ];
  const activeBefore = new Set(["already-active"]);

  // act
  const picked = pickNewSession(entries, activeBefore);

  // assert
  assert.equal(picked?.slug, "new-newest");
});

test("pickNewSession returns undefined when nothing new is active", () => {
  // arrange
  const entries = [
    entry({ slug: "already-active", active: true }),
    entry({ slug: "inactive", active: false }),
  ];
  const activeBefore = new Set(["already-active"]);

  // act
  const picked = pickNewSession(entries, activeBefore);

  // assert
  assert.equal(picked, undefined);
});

test("advanceQuiet returns undefined for zero unseen comments", () => {
  // arrange
  const previous = undefined;

  // act
  const state = advanceQuiet(previous, 0, 1000);

  // assert
  assert.equal(state, undefined);
});

test("advanceQuiet sets since when count first becomes non-zero", () => {
  // arrange
  const previous = undefined;

  // act
  const state = advanceQuiet(previous, 2, 1000);

  // assert
  assert.deepEqual(state, { count: 2, since: 1000 });
});

test("advanceQuiet keeps the same state when count is unchanged", () => {
  // arrange
  const previous = { count: 2, since: 1000 };

  // act
  const state = advanceQuiet(previous, 2, 5000);

  // assert
  assert.deepEqual(state, { count: 2, since: 1000 });
});

test("advanceQuiet resets since when count grows", () => {
  // arrange
  const previous = { count: 2, since: 1000 };

  // act
  const state = advanceQuiet(previous, 3, 5000);

  // assert
  assert.deepEqual(state, { count: 3, since: 5000 });
});

test("quietElapsed is false before quietMs and true at or after it", () => {
  // arrange
  const state = { count: 1, since: 1000 };

  // act
  const before = quietElapsed(state, 10_999, 10_000);
  const atThreshold = quietElapsed(state, 11_000, 10_000);
  const after = quietElapsed(state, 20_000, 10_000);

  // assert
  assert.equal(before, false);
  assert.equal(atThreshold, true);
  assert.equal(after, true);
});

test("formatComments renders a review-level comment without a path as review-level", () => {
  // arrange
  const comments = [comment({ path: undefined, location: "review", comment_type: "none" })];

  // act
  const formatted = formatComments(comments);

  // assert
  assert.match(formatted, /review-level/);
});

test("formatComments renders a line comment as path:line", () => {
  // arrange
  const comments = [
    comment({ path: "src/main.rs", location: "src/main.rs:42", comment_type: "none" }),
  ];

  // act
  const formatted = formatComments(comments);

  // assert
  assert.match(formatted, /src\/main\.rs:42/);
});

test("formatComments renders type none without a tag", () => {
  // arrange
  const comments = [comment({ comment_type: "none" })];

  // act
  const formatted = formatComments(comments);

  // assert
  assert.doesNotMatch(formatted, /\[none\]/);
});

test("shellQuote escapes single quotes", () => {
  // arrange
  const value = "a'b";

  // act
  const quoted = shellQuote(value);

  // assert
  assert.equal(quoted, "'a'\\''b'");
});

const LAYOUT = `layout {
    cwd "/home/user"
    tab name="Tab #1" {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane cwd="other"
        floating_panes {
            pane command="claude" cwd="other"
        }
    }
    tab name="Tab #2" focus=true hide_floating_panes=true {
        pane command="nvim" cwd="config"
        floating_panes {
            pane command="/opt/homebrew/bin/pi" cwd="config" focus=true {
                args "--yolo"
            }
        }
    }
    new_tab_template {
        pane
    }
}
`;

test("floatingPaneCommands returns the focused tab's floating pane commands by basename", () => {
  // arrange
  const layout = LAYOUT;

  // act
  const commands = floatingPaneCommands(layout);

  // assert
  assert.deepEqual([...commands], ["pi"]);
});

test("floatingPaneCommands ignores tiled panes and floating panes of unfocused tabs", () => {
  // arrange
  const layout = LAYOUT;

  // act
  const commands = floatingPaneCommands(layout);

  // assert
  assert.equal(commands.has("nvim"), false);
  assert.equal(commands.has("claude"), false);
});

test("floatingPaneCommands finds nothing when the focused tab has no floating panes", () => {
  // arrange
  const layout = `layout {
    tab name="Tab #1" focus=true {
        pane command="nvim" cwd="config"
    }
    tab name="Tab #2" {
        floating_panes {
            pane command="pi"
        }
    }
}
`;

  // act
  const commands = floatingPaneCommands(layout);

  // assert
  assert.equal(commands.size, 0);
});

test("floatingPaneCommands is not thrown off by braces inside quoted arguments", () => {
  // arrange
  const layout = `layout {
    tab name="Tab #1" focus=true {
        pane command="bash" {
            args "-c" "f() { :; }"
        }
        floating_panes {
            pane command="pi"
        }
    }
}
`;

  // act
  const commands = floatingPaneCommands(layout);

  // assert
  assert.deepEqual([...commands], ["pi"]);
});
