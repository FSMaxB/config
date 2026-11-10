---
name: interactive-mermaid
description: Build mermaid diagrams that render in Pi's interactive chat. Use when explaining architecture, control flow, data flow, dependencies between components or state machines, and when the user asks to "diagram this", "draw", "sketch" or "show me" how something works. Covers which diagram types Pi's terminal renderer draws, how to keep a diagram narrow enough to render, how to highlight and link nodes, and the text sketches to use for things that are not graphs.
---

# Interactive mermaid

Pi renders top-level ```mermaid blocks in assistant output as box-drawing art
in the terminal (the `lovely-mermaid` package, bundled into Pi and controlled
by the `markdown.mermaid` setting). Expanded compaction and branch summaries
render them too; thinking does not. Other harnesses print the raw source, so
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

Pi draws these nine. Any other type (`gantt`, `journey`, `block-beta`,
`xychart-beta`, `quadrantChart`, `sankey-beta`, `C4Context`, ...) is printed
as raw source, so never use it.

| Type | Recommended for |
| --- | --- |
| `flowchart` | structure, dependencies, data flow |
| `sequenceDiagram` | interactions over time |
| `stateDiagram-v2` | state machines |
| `classDiagram` | type relations and ownership |
| `erDiagram` | data models |
| `gitGraph` | branch, merge and rebase history |
| `timeline` | releases and other dated events |
| `mindmap` | a hierarchy without cross links |
| `pie` | proportions, drawn as a labelled bar list |

The right column is a recommendation; pick the type whose shape matches the
relation you are explaining.

## Keep it narrow

The renderer draws at whatever width the diagram needs and Pi compares that
with the width available to the message. A diagram that does not fit is
printed as raw source, so width is the budget that matters.

- Flowcharts go top-down: `flowchart TD`. Use `LR` only for a chain of at most
  four short nodes, or to put a few subgraphs side by side. Measured with
  labels like `Child 1`: a six-node chain is 86 columns in `LR` and 12 in `TD`.
- Siblings sit side by side, about 14 columns each with labels like
  `Child 1`: a node with five children is 68 columns wide, with seven 96. Put
  an intermediate node between a parent and many children, or split the
  diagram.
- In a sequence diagram the longest message between two participants sets
  their distance: one 55-character message makes a two-participant diagram 62
  columns wide. Keep message texts short and move details to the prose.
- Labels are one to three words. No file paths, URLs, function signatures or
  parameter lists in a box or on an arrow. Details go in the prose next to
  the diagram.
- A long node label wraps inside its box at about 24 columns, so it costs
  height rather than width. A line break cannot be forced: `<br/>` becomes a
  space and a literal newline inside a label breaks the parse.
- Edge labels never wrap: anything past 27 characters is cut off with `…`.

## Syntax

Pi prints the source instead of the diagram when the renderer reports any
parse warning, so one bad line costs the whole picture. While a message is
still streaming Pi draws the diagram anyway, so a broken diagram can show up
during streaming and turn into source when the message is complete.

- Readable node IDs: `router["Request router"]`, not `A[Request router]`.
  Kebab-case IDs such as `step-1` work. Unquoted labels tolerate parentheses,
  pipes, colons, slashes and quotes; a `]` or `;` inside a label needs the
  quoted form. Quote every label anyway: it costs nothing, and the same
  source gets pasted into READMEs, where mermaid.js breaks on unquoted
  parentheses.
- Link every box that stands for a file to that file, so the reader can open
  it from the diagram: `click store "file:///Users/me/repo/src/store.ts"` in a
  flowchart, `link Store "file:///Users/me/repo/src/store.ts"` in a class
  diagram. Use absolute `file://` paths or full URLs; a relative path does
  not resolve. Pi turns the label into a link on terminals that support links
  and leaves plain text elsewhere. Other diagram types have no links.
- Highlight the one or two nodes the explanation is about with a class, never
  every node: `classDef focus fill:#d79921,color:#000` plus
  `changed["Changed node"]:::focus` or `class changed focus`. Pi paints
  `fill`, `stroke`, `color` and `font-weight:bold`.
- A `title:` in `---` frontmatter is drawn above the diagram; other
  frontmatter keys are ignored. The `@{ shape: ..., label: "..." }` node
  syntax works.
- These are ignored and only cost tokens: `style`, `linkStyle`,
  `%%{init: ...}%%` and `click` callbacks (`click a callback`).
- These make the render fail: a `title:` line outside frontmatter, `accTitle:`
  and `accDescr:` lines, the invisible link `~~~`, the double circle
  `(((x)))`, and in `erDiagram` a `direction` line.

## What the renderer draws

Tested on `lovely-mermaid` 0.3.3. Do not spend lines on what it drops.

- Flowcharts have three node looks: square corners (`[x]`, `[[x]]`, `>x]`),
  rounded corners (`(x)`, `([x])`, `[(x)]`, `((x))`) and a double border for
  decisions (`{x}`, `{{x}}`, `@{ shape: diamond }`). So a double border can
  mark a decision; say what any other node is in its label. Parallelograms and
  trapezoids (`[/x/]`, `[\x\]`, `[/x\]`) come out as rectangles with the
  slashes left in the label. Link styles are all distinct: solid `-->`,
  dotted `-.->`, thick `==>`, circle end `--o`, cross end `--x` and both ways
  `<-->`, so a link style can carry meaning if the prose says which. Two
  edges between the same nodes share one label (`one / two`). `direction`
  inside a `subgraph` is ignored; subgraphs follow the diagram's direction.
- State diagrams draw composite states as titled frames, `--` as regions side
  by side inside a composite, `<<choice>>` with a double border, and honour
  `direction LR`. `note` lines are dropped, and `<<fork>>` and `<<join>>`
  look like ordinary states. A description (`Idle : waits for input`)
  replaces the state's name in its box, so write the description as the
  label, or use `state "Waiting for input" as Idle`.
- Sequence diagrams draw `alt`/`else`, `par`/`and`, `loop`, `opt`,
  `critical` and `break` as labelled dividers, `Note` (over, left of, right
  of), `autonumber`, activations (`activate`/`deactivate`, `+`/`-` on an
  arrow) as a double lifeline, and the `->>`, `-->>`, `-x` and `-)` arrows.
  `box` and `rect` are not drawn, and an `actor` looks like a participant.
- Class diagrams draw generics, annotations, visibility markers,
  cardinalities and relation labels. Write a generic class the same way
  everywhere: after `class Car~T~`, a relation to `Car` creates a second,
  separate `Car` box, so write `Car~T~ <|-- Sedan`. `note` and `namespace`
  are dropped. Relations that leave the same side of a box share one marker,
  so composition and aggregation can look alike there.
- ER diagrams draw attributes with their keys (`PK`, `FK`), aliases
  (`C[Customer]`, `a["Bank Account"]`), quoted entity names and all
  cardinalities. Attribute comments (`string name "full name"`) are dropped.
- `pie` draws one bar per slice with its percentage; `showData` adds the raw
  values. `mindmap` draws the indented tree with `├──` guides and ignores node
  shapes. `timeline` lists each period with its events, with sections as
  headers. `gitGraph` draws `git log --graph`-style lanes, newest commit on
  top, with branch heads, tags and merges.

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
