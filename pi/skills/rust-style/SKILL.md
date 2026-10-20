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
- When a value is cloned (or otherwise prepared) only to be moved into a closure or async block, do it in a block expression that wraps that closure, shadowing the original name. This keeps the clone next to its only use and out of the surrounding scope.
  ```rust
  thread::spawn({
      let a = a.clone();
      move || use_a(a)
  });
  ```
- Instead of reassigning a `let mut` binding later, introduce a fresh `let` binding with the same name.
- Use the collection traits before reaching for a loop: collect an iterator of pairs into `(Vec<_>, Vec<_>)`, an iterator of `Result<T, E>` into `Result<Vec<T>, E>`, and use `try_fold` or `fold` for accumulations.
- When a value is either borrowed or freshly built, use `Cow` instead of a late-initialized `let filtered;` binding.
- Import items instead of fully qualifying them at the use site (`use tokio::sync::mpsc;`, `use std::iter;` then `iter::once`).
- Name ignored bindings `_`, not `_error`, unless a lint requires otherwise.

## Errors

- `?` already converts errors. When an explicit conversion is needed, write `ErrorType::from`, not `Into::<ErrorType>::into`.
- Use `ensure!(condition, "...")` instead of `if !condition { bail!(...) }`.
- `bail!` and `anyhow!` format by themselves; don't wrap a `format!` in them.
- Use `.context(...)` / `.with_context(|| ...)` instead of `.map_err(|error| anyhow!("...: {error}"))`.
- Use `.inspect_err(...)` to log an error on its way up.
- Use `.map(drop)` instead of `.map(|_| ())`.

## Async

- Box futures with `.boxed()` from `futures_util`, never `Box::pin(...)`.
- When clippy reports `large_futures`, box the future before `.await` instead of silencing the lint.
- Use `std::pin::pin!` instead of `pin_mut!` or `tokio::pin!`.
- Depend on `futures-util` instead of `futures` whenever it's enough.
- Use native `async fn` in traits instead of `async_trait` unless the trait is used as a trait object.
- Prefer `CancellationToken::run_until_cancelled` over a `tokio::select!` on `cancelled()`. If you do need `select!`, remember it polls branches in random order unless you add `biased;`.

## Traits and derives

- Implement standard traits instead of ad-hoc methods: `From`/`TryFrom` instead of `to_x`/`decode_x`, `FromStr` instead of `from_string`, `PartialOrd`/`Ord` instead of comparison helpers.
- Derive `Debug` instead of implementing it by hand when the output would be the same.
- Use `strum` (for example `IntoStaticStr` with snake case) instead of hand-written `as_str` matches, and `derive_more::Display` for trivial `Display` implementations.
- Implement `Clone` manually on generic wrappers with `PhantomData` markers instead of forcing `T: Clone` bounds everywhere.

## Numbers

- Use `usize` for counts and lengths so they don't need conversions.
- Use `NonZero*` types instead of runtime checks for zero.

## Macros

- Generated code refers to crates with absolute paths (`::serde::Serialize`), never bare `serde::Serialize`, so a local module with the same name can't shadow them.
