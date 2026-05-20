---
name: hyper-tdd
description: Use when about to write or modify behavior-bearing code — functions, business logic, bug fixes — before writing any production code. Also when the user invokes /hyperclaude:hyper-tdd. Forces a failing test first so you watch it fail for the right reason.
---

# hyper-tdd

Test-driven discipline tailored to this author's preferences.

## The loop

1. **Write the failing test first.** Name the behavior, not the implementation. The test should compile/import but fail because the behavior doesn't exist yet.
2. **Run it. Confirm it fails for the right reason.** "Cannot find function" is fine. "ReferenceError because of typo in test" is not — fix the test.
3. **Write the minimum code to make it pass.** Resist scope creep. No "while I'm here" edits.
4. **Run it. Confirm it passes.**
5. **Commit.** One behavior, one commit. Commit messages describe the behavior, not the code.
6. **Refactor if there's a clear smell.** Tests must still pass after.

## Skip TDD when

- Touching only documentation, comments, or formatting.
- Renaming a symbol (an LSP/grep operation, not a behavior change).
- One-shot migration scripts that run once and get deleted.
- Config-only changes (e.g., updating a `.gitignore`).

## What "minimum" means here

Implement only what the current test requires. If you need a helper, add the simplest version. Do not pre-build for tests you might write later — write that test first, then the helper.

## What good test names look like

- ✅ `slugify drops non-ASCII characters`
- ✅ `cli --dry-run prints JSON without spawning codex`
- ❌ `test_slugify` (says nothing)
- ❌ `slugify works correctly` (vague)
