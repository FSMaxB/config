---
name: interactive-mermaid
description: Build mermaid diagrams that render in Pi's interactive chat. Use when explaining architecture, control flow, data flow, dependencies between components or state machines, and when the user asks to "diagram this", "draw", "sketch" or "show me" how something works. Covers which diagram types Pi's terminal renderer draws, how to keep a diagram narrow enough to render, and the text sketches to use for things that are not graphs.
---

# Interactive mermaid

Pi renders top-level ```mermaid blocks in assistant output as box-drawing art
in the terminal (the `grok-mermaid` package, bundled into Pi and controlled
by the `markdown.mermaid` setting). Other harnesses print the raw source, so
the diagram rules below apply to Pi only. Elsewhere, skip the diagram and use
a text sketch from the last section.

## When to draw

- Draw a diagram when explaining an architectural decision or how something
  works: control flow, data flow, dependencies between components, state
  machines. Also draw on an explicit ask: "diagram this", "draw", "sketch",
  "show me".
- Only draw what the prose cannot say in a sentence. A linear sequence of
  steps is a numbered list, not a diagram.
- One concern per diagram, roughly ten nodes at most. Split rather than cram.
- Each diagram is a zoomed-in piece of the whole. Collapse everything outside
  the zoom into a single box instead of drawing it.

## Diagram types

Pi draws exactly these five. Any other type (`gitGraph`, `pie`, `mindmap`,
`gantt`, `timeline`, `journey`, `xychart-beta`, `quadrantChart`, `block`,
`C4`, ...) is printed as raw source, so never use it.

| Type | Recommended for |
| --- | --- |
| `flowchart` | structure, dependencies, data flow |
| `sequenceDiagram` | interactions over time |
| `stateDiagram-v2` | state machines |
| `classDiagram` | type relations and ownership |
| `erDiagram` | data models |

The right column is a recommendation; pick the type whose shape matches the
relation you are explaining.

## Keep it narrow

The renderer draws at whatever width the diagram needs and Pi compares that
with the width available to the message. A diagram that does not fit is
printed as raw source, so width is the budget that matters.

- Flowcharts go top-down: `flowchart TD`. Use `LR` only for a chain of at most
  four short nodes. Measured: a six-node chain is 111 columns in `LR` and 20
  in `TD`.
- Labels are one to three words. No file paths, URLs, function signatures or
  parameter lists in a box or on an arrow. Details go in the prose next to
  the diagram.
- A long label wraps inside its box at about 24 columns, so it costs height
  rather than width. A line break cannot be forced: `<br/>` becomes a space
  and a literal newline inside a label breaks the parse.

## Syntax

A parse warning makes Pi print the source instead of the diagram, so one bad
line costs the whole picture.

- Readable node IDs: `router["Request router"]`, not `A[Request router]`.
  Unquoted labels tolerate parentheses, pipes, colons, slashes and quotes; a
  `]` or `;` inside a label needs the quoted form. Quote every label anyway:
  it costs nothing, and the same source gets pasted into READMEs, where
  mermaid.js breaks on unquoted parentheses.
- No `classDef`, `style`, `linkStyle`, `click`, `:::class` or
  `%%{init: ...}%%`. They are silently ignored and only cost tokens.
- These make the render fail: `---` frontmatter, `title:`, `accTitle:` and
  `accDescr:` lines, the invisible link `~~~`, the `@{ shape: ... }` node
  syntax, the double circle `(((x)))`, and in `erDiagram` a `direction` line
  or a quoted entity name.

## What the renderer drops

Tested on `grok-mermaid` 0.2.3. Do not spend lines on these.

- State diagrams: `note` lines are dropped, composite states are drawn flat
  (so nesting carries no meaning), `--` concurrency separators are ignored,
  and `<<choice>>`, `<<fork>>` and `<<join>>` look like ordinary states.
- Flowcharts: `direction` inside a `subgraph` is ignored. There are only two
  node looks, square corners (`[x]`, `[[x]]`, `>x]`) and rounded corners
  (`(x)`, `([x])`, `[(x)]`, `((x))`, `{x}`, `{{x}}`), so shape cannot carry
  meaning; say what a node is in its label or the prose. Parallelograms and
  trapezoids (`[/x/]`, `[\x\]`, `[/x\]`) come out as rectangles with the
  slashes left in the label.
- Sequence diagrams draw `alt`/`else`, `par`/`and`, `loop`, `opt`,
  `critical` and `break` as labelled dividers, `Note` (over, left of, right
  of), `autonumber`, and the `->>`, `-->>`, `-x` and `-)` arrows. `box`,
  `rect`, `actor` and `activate`/`deactivate` (also `+`/`-` on an arrow) are
  accepted but not drawn.
- Class diagrams draw generics, annotations, visibility markers,
  cardinalities and relation labels; `note` and `namespace` are dropped.
- ER diagrams draw attributes with `PK`/`FK`/`UK` and comments, aliases
  (`C[Customer]`) and all cardinalities.

## Editing a diagram

When the user asks to change a diagram, re-emit the whole updated block, not
a description of the edit. Keep node IDs stable across turns so the change
reads as a diff of a few lines.

## Text sketches for things that are not graphs

When the relation is not graph-shaped, or the harness does not render
mermaid, use the smallest text view that makes the point. Place it next to
the sentence it supports.

Logic or an algorithm as pseudocode:

```text
on(save)
  if content is unchanged
    return cached result
  write new content
  return fresh result
```

Runtime control flow as an indented call tree:

```text
submitForm
  createSession
    persistPrompt
    launchAgent
  navigateToSession
```

File responsibilities or a broad refactor as a shallow file tree:

```text
src/
├── commands/       # parses user actions
├── sessions/       # owns session state
└── transport/      # sends API requests
```

What changes, when the surrounding shape already exists, as a `diff` block
over the same sketch:

```diff
 submitForm
   createSession
     persistPrompt
+    expandSkillMention
     launchAgent
-  navigateToSession
+  navigateToSession
+    subscribeToEvents
```
