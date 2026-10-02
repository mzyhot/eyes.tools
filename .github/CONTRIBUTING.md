# Contributing

## Before you start

- **New tools:** open an issue or a discussion first. A tool has to run in the
  browser and fit in one file.
- **Bugs and fixes:** send a pull request. For changes to share or the server,
  open an issue first.
- **Security issues:** report them privately, as described in
  [SECURITY.md](SECURITY.md).

## How the project works

- [README.md](../README.md): the layout, and which file to edit for what.
- [_dev/CONTRACT.md](../_dev/CONTRACT.md): the rules every tool page follows.
  Read it before writing a tool.
- [AGENTS.md](../AGENTS.md): the review rules for share, network identity and
  the published files.

## Checks

Run these before opening a pull request:

```bash
npm run check
npm test
```

Changes to a page, the shared runtime or share also need the browser suite;
see Testing in the README. CI runs all three.

## Licensing

Contributions are licensed under the GNU AGPL-3.0 ([LICENSE](../LICENSE)) with
the additional terms in [ADDENDUM](../ADDENDUM). Only submit work you have the
right to license this way.
