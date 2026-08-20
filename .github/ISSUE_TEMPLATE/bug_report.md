---
name: Bug report
about: Report a defect so it can be reproduced and fixed
title: "[Bug]: "
labels: bug
assignees: ""
---

## Description

A clear description of what the bug is and what you expected to happen instead.

## Reproduction steps

Steps to reproduce the behavior. A minimal code snippet is ideal:

1. ...
2. ...
3. ...

```ts
// minimal repro
```

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include any error messages or stack traces.

## Environment

- sql-switch version: <!-- e.g. 0.1.0 -->
- Node version: <!-- `node -v`, e.g. 22.x -->
- OS: <!-- e.g. Ubuntu 24.04, macOS 15, Windows 11 -->
- Engine: <!-- SQLite or PostgreSQL (and pg version if relevant) -->
- Write collector: <!-- enabled (default) or disabled? were you using .force()? -->

## Additional context

Anything else that might help: configuration, logs, whether the circuit breaker
tripped, or whether this involved an engine swap.
