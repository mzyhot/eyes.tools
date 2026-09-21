# Contributing

Thanks for helping. eyes.tools is small on purpose, so a short read saves a
rejected pull request.

## Before you start

- **New tools:** open a discussion or an issue first. The site grows slowly, and
  a tool has to be useful, local, and small enough to live in one file.
- **Bugs and fixes:** a pull request is welcome straight away. For anything
  that touches share or the server, an issue first helps.
- **Security problems:** do not open an issue. See [SECURITY.md](SECURITY.md).

## How the project works

- [README.md](../README.md) — the layout and what to edit for what.
- [_dev/CONTRACT.md](../_dev/CONTRACT.md) — the rules every tool page follows.
  Read it in full before writing a tool.
- [AGENTS.md](../AGENTS.md) — the review rules for share, network identity and
  the published surface. They apply to people too.

## Checks

Every pull request must pass:

```bash
npm run check
npm test
```

Changes to a page, the shared runtime or share should also pass the browser
suite described in the README's Testing section. CI runs all three.

## Licensing of contributions

By submitting a contribution you agree that it is licensed under the
project's terms: the GNU AGPL-3.0 ([LICENSE](../LICENSE)) with the additional
terms in [ADDENDUM](../ADDENDUM). Only submit work you have the right to
license that way.
