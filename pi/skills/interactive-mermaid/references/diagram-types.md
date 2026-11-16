# What the renderer draws, per diagram type

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
