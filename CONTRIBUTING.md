# Development

This project has Python tools and a web GUI in TypeScript. [mise](https://mise.jdx.dev/) pins the tool versions in `mise.toml`. CI and your computer run the same mise tasks.

## Set up

1. Install mise.
2. Run these commands in the repository root.

```bash
mise install
mise run setup
mise run check
```

`mise run check` runs the same steps as CI. Run it before you push.

## Tasks

| Task                 | Result                                                              |
| -------------------- | ------------------------------------------------------------------- |
| `mise run dev`       | Serves the web GUI on http://localhost:8000.                        |
| `mise run fmt`       | Formats the Python and TypeScript code and applies safe lint fixes. |
| `mise run lint`      | Runs ruff and Biome.                                                |
| `mise run typecheck` | Runs ty and tsc.                                                    |
| `mise run test`      | Runs pytest, Vitest and Playwright.                                 |
| `mise run build`     | Builds the web GUI into `web/dist`.                                 |
| `mise run check`     | Runs lint, typecheck, test and build.                               |

Each language has its own tasks, for example `lint:py`, `test:unit` and `test:e2e`. Run `mise tasks` to see all tasks.

## Tools

| Part       | Tools                                     |
| ---------- | ----------------------------------------- |
| Python     | uv, ruff, ty, pytest                      |
| TypeScript | npm, Vite, tsc, Biome, Vitest, Playwright |

Add a Python dependency with `uv add NAME`. Add a web dependency with `npm install --save-exact NAME`. Commit `uv.lock` and `package-lock.json`.

## Tests

- `tests/` has the Python tests.
- `web/tests/unit/` has the Vitest tests.
- `web/tests/e2e/` has the Playwright tests. They use a mock serial port, so they do not need a printer.

The tests use `tests/fixtures/FiraCode-subset.ttf`. They do not use system fonts, so the result is the same on all computers.

`tests/fixtures/protocol.json` has the expected printer bytes. The Python tests and the web tests read this file. If you change the protocol, run this command and examine the changes:

```bash
UPDATE_GOLDEN=1 uv run pytest tests/test_protocol_golden.py
```

The parity tests compare the web raster with the Python raster, dot by dot. `tests/ref_raster.py` gives the Python raster. These tests run on Linux only, because the font metrics on macOS change with the macOS version.

## Deployment

`.github/workflows/deploy.yml` publishes `web/dist` to GitHub Pages after a push to `main`.
