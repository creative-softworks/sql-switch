# Security Policy

## Reporting a vulnerability

Please don't open a public issue for security problems.

Use GitHub's private reporting instead: go to the repo's **Security** tab and
click **Report a vulnerability** (this opens a private security advisory only
the maintainer can see). That keeps the details out of public view until
there's a fix.

Include enough to reproduce it => affected version, engine (SQLite or
PostgreSQL), and a minimal snippet or steps if you have them.

You can expect a best effort reply within a few days. This is a small project,
so response times aren't guaranteed, but reports are taken seriously.

## Supported versions

This is a pre-1.0 (0.x) library. Only the latest published minor gets fixes.
Older 0.x lines are not patched => upgrade to the current minor to pick up a
fix.

| Version        | Supported |
| -------------- | --------- |
| latest 0.x     | yes       |
| older 0.x      | no        |

## Attack surface worth knowing

sql-switch is a database abstraction layer, so the injection relevant spots
are narrow but real:

- **schema & table name validation** => these names get woven into physical
  targets (a `.db` file path on SQLite, a logical schema on PostgreSQL). Names
  that slip past validation are the main structural risk.
- **value serialization** => how row values are encoded on the way into a
  driver. Parameter binding is the safe path here.

If you find a way to smuggle input past either of these, that's exactly the
kind of report worth sending.
