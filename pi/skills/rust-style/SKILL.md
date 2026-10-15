---
name: rust-style
description: Rust code style rules for writing or editing Rust code. Use whenever you add or change Rust code.
---

# Rust style

- Liberally use struct and enum destructuring, especially if it allows you to avoid an explicit type declaration of a let binding.
- Inside modules that aren't reachable from outside the crate, use pub instead of pub(crate) or pub(super).
- If you want to make clear that something cannot happen, use `.unwrap_or_else(|| unreachable!(...))` instead of `.expect(...)`.
- If types can be inferred, let them be inferred.
- Prefer specifying types to the right of the `=`. E.g. `.collect::<Vec<_>>()` instead of `let foo: Vec<_> = ....collect();`
- Put constants in the smallest scope possible (e.g. function scope if only used in that function)
- Prefer `let Some(...) = foo else { /* early exit / continue */ }` to nesting code in `if let Some` (same for other enums than Option).
- Avoid `let mut` wherever possible as long as the alternative isn't significantly more complex.
- Prefer iterator or stream combinator style over loops mutating a variable
