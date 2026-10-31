# TODO

**Date:** 2026-10-31.
**Branch:** `tooling` of `anyasabo/PT-P300BT`.

The items are in priority order. Each item is complete: you do not need to read the other items first.

## Context for all items

- This fork has a Python tool (`printlabel.py`, `ptgui.py`) and a web GUI (`web/src/`) for the Brother PT-P300BT label printer.
- The web GUI is a port of the Python tool. If you change the layout or the protocol, change both.
- Run `mise install && mise run setup` once. Run `mise run check` before each push. Refer to [CONTRIBUTING.md](CONTRIBUTING.md).
- The site is at https://anyasabo.github.io/PT-P300BT/. A push to `tooling` publishes it immediately. CI does not stop the deploy (item 3).
- `main` still has the upstream code. Do not push to `main`.
- Do not open upstream issues or pull requests.
- Write documents and commit messages in Simplified Technical English.
- Printed labels have 64 dots of print height: rows 12 to 75 of an 88-row image.

## Summary

| # | Item | Size | Needs |
| --- | --- | --- | --- |
| 1 | Test the live site on the printer | Small | Printer |
| 2 | Make the No print checkbox operate | Small | None |
| 3 | Deploy only after CI passes | Small | None |
| 4 | Give feedback when PRINT does nothing | Small | None |
| 5 | Stop long labels in Python | Small | None |
| 6 | Measure the dot size | Small | Printer |
| 7 | Find ligatures in monospaced fonts | Medium | None |
| 8 | Keep the loaded font in ligature mode | Medium | None |
| 9 | Fix the small web bugs | Small | None |
| 10 | Test the release and CodeQL workflows | Small | A tag |
| 11 | Add Python test coverage | Medium | None |
| 12 | Remove the ctypes warning | Small | None |
| 13 | Resolve the two parity differences | Medium | Linux |
| 14 | Decide how `main` gets this work | Small | Decision by the user |
| 15 | Split the work into upstream pull requests | Large | Decision by the user |

## 1. Test the live site on the printer

**Why:** the TypeScript build has not printed a label. The Bluetooth retry has not operated in Chrome, because the last connections had a link already.

**Steps:**

1. Turn on the printer. Do not connect to it for 2 minutes, so that there is no Bluetooth link.
2. Open the live site in Chrome. The new address asks for the font and serial permissions again.
3. Click **Connect printer**. Select the entry that does not start with `cu.`.
4. Print `SOS`.

**Done when:** the log shows `Attempt 1 failed` and then `Printer connected`, and the tops of the letters are complete on the tape.

**If it fails:** copy the page log and all of `chrome://device-log`. The cause is in `SerialTransport.open` in `web/src/printer.ts`. The root cause is [Chromium issue 569041183](https://issues.chromium.org/issues/569041183). The Bluetooth link stays up for about 6 seconds after the first attempt fails.

## 2. Make the No print checkbox operate

**Problem:** a user can select **No print**, click PRINT, and the printer still uses tape.

**Where:**

- `web/src/app.ts:276`: `makeArgs(noPrint)` sets `no_print` from its argument. `doPrint` calls `makeArgs(false)`, so the checkbox has no effect.
- `ptgui.py:1538`: `_do_print` calls `self._make_args(no_print=False)`. It has the same problem.
- If `no_print` is true, `web/src/printer.ts:715` and `labelmaker.py:191` already skip the print command.

**Change:** read the checkbox at the two locations: `bool('no_print')` in `app.ts` and `self.vars["no_print"].get()` in `ptgui.py`.

**Test:** add a Playwright test with the mock port from the connect tests in `web/tests/e2e/app.spec.ts`. Select the checkbox, print, and make sure that the last byte written is not `0x1a`.

**Done when:** the test passes, and `mise run check` passes.

## 3. Deploy only after CI passes

**Problem:** `.github/workflows/deploy.yml` starts on each push, at the same time as CI. A failed build can go live.

**Change:** move the deploy into `.github/workflows/ci.yml`:

1. Change the trigger of `deploy.yml` to `workflow_call`.
2. In `ci.yml`, add a `deploy` job with `needs: check`, `uses: ./.github/workflows/deploy.yml`, and `permissions` of `pages: write` and `id-token: write`.
3. Run the job only for a push to `main` or `tooling`.

**Do not use** `workflow_run`. It reads the workflow file from the default branch, and `main` does not have this file.

**Done when:** a push that fails CI does not deploy, and a push that passes CI deploys. The `github-pages` environment already permits `main` and `tooling`.

## 4. Give feedback when PRINT does nothing

**Problem:** if `state.busy` is true, `doPrint` in `web/src/app.ts:541` returns with no message. A live preview sets `state.busy`, so a click on PRINT can have no effect.

**Change:** wait for the preview to finish, and then print. If a print is in progress, show a message in the status line. Do not start a second print.

**Test:** add a Playwright test that clicks PRINT during a preview. The over-limit print test in `web/tests/e2e/app.spec.ts` has a retry loop for this problem: remove the loop.

**Done when:** one click always gives a print or a message.

## 5. Stop long labels in Python

**Problem:** the printer limit is 499 mm, or 3536 raster lines at 180 DPI. The web GUI refuses a longer label. The Python CLI and GUI send it, and the printer prints only part of it.

**Where:** add the check in `printlabel.py` after `rasterize_label`, before the job goes to the printer. Use the name `MAX_RASTER_LINES`, as in `web/src/app.ts:527`. Raise `_LabelError`.

**Test:** add a test to `tests/test_build_label.py`.

**Done when:** a label over the limit gives an error and sends no data. `-n` also gives the error, so that a user finds the problem early.

## 6. Measure the dot size

**Problem:** the code uses 0.149 mm for each dot. At 180 DPI one dot is 0.141 mm. Tape lengths on the screen, `--fixed-width` and `--text-size` can have an error of about 5%.

**Steps:**

1. Print a label with **Fixed width** set to 100 mm. Add `|` at each end of the text, so that you can measure the distance.
2. Measure the printed length.

**Result:** a length of about 95 mm shows that 0.141 is correct.

**Where:** `web/src/label.ts:71` (`MM_PER_DOT`), `printlabel.py:1708`, `1827`, `1869` and `1977`, and `tests/test_build_label.py`. Use one constant in Python.

**Done when:** the printed length agrees with the setting. `MAX_RASTER_LINES` counts lines, so it does not change.

## 7. Find ligatures in monospaced fonts

**Problem:** `probeLigatureFeatures` in `web/src/label.ts:259` compares text widths. A feature in a monospaced font does not change the width, so the list is empty. Python reads the GSUB table in `_lig_features` (`printlabel.py:549`).

**Change:** make the probe find features that change the glyphs. A possible method is to compare rendered pixels for each feature tag. Another method is to parse the GSUB table. For an installed font, get the file with `FontData.blob()`.

**Test:** change `test.fail` to `test` at `web/tests/e2e/app.spec.ts:219`.

**Done when:** the test passes with the fixture font, and the probe does not make the preview slow.

## 8. Keep the loaded font in ligature mode

**Problem:** with a ligature feature on, `svgRender` in `web/src/label.ts:304` draws an SVG image. An SVG image cannot see the fonts of the page, so a font from **Load font file** changes to a default font. Installed fonts are correct.

**Change:** keep the bytes of each loaded font. Embed them as a `data:` URL in an `@font-face` rule in the SVG. The canvas has no standard property for GSUB features, so the SVG path stays.

**Test:** change `test.fail` to `test` at `web/tests/e2e/app.spec.ts:240`.

**Done when:** the test passes, and the ink position agrees with the normal path.

## 9. Fix the small web bugs

Each bug is one small commit.

- `svgRender` at `web/src/label.ts:329` does not escape the family, the fill or the stroke for XML. A font name with `&` can stop the SVG. Use `_escapeXml`.
- `buildLabel` at `web/src/label.ts:1051` changes `args.line_spacing`. Use a local variable.
- `loadFontFile` at `web/src/app.ts:236` adds a new option for each load. Replace an option with the same name. Clear the file input value after a load, so that the same file can load again.
- On text with lowercase ascenders, for example `hug` in TeX Gyre Adventor Bold, a sliver of about 8 dots goes on row 11. Find why the whole-dot metrics in `WebFont.getbbox` do not include it.
- `fontbrowser._humanize` documents that `arialbd.ttf` gives `Arial Bold`, but it gives `Arialbd`. Fix the code or the docstring.

## 10. Test the release and CodeQL workflows

**Problem:** the changes to `.github/workflows/build.yml` have not operated. It runs only on a `v*.*.*` tag, on Windows. The CodeQL workflow runs on `main` and on a schedule.

**Steps:** push a test tag such as `v0.0.1-test`, and examine the run. Then remove the tag and the release. Note that the workflow has a step that removes old releases.

**Check:** `printlabel.spec` with Python 3.15, and `mise exec` on Windows.

**Done when:** `printlabel.zip` has an executable that starts.

## 11. Add Python test coverage

**Now:** 34% in total. `printlabel.py` has 37%, `native/btcommon.py` has 22%, and `ptgui.py` has no tests.

**Priority:**

1. `labelmaker.do_print_job` with a fake serial port. Use the fake from `tests/test_print_status.py`.
2. `printlabel.process_image` and `--merge`.
3. The `main()` argument errors.
4. The name selection in `btcommon.find_device`.

Do not add tests for the Tk windows. To test logic in `ptgui.py`, move it out of that file first.

**Done when:** the four areas have tests, and `pytest --cov` shows the increase.

## 12. Remove the ctypes warning

**Problem:** Python 3.15 gives a `DeprecationWarning` for `StatusRegister` in `ptstatus.py:135`, because of `_pack_`.

**Change:** do what the warning text tells you. Make sure that `tests/test_print_status.py` still sees 32 bytes and the same offsets.

**Done when:** `pytest` has no warnings. Then add `-W error` to `addopts` in `pyproject.toml`.

## 13. Resolve the two parity differences

**Problem:** on Linux, `tab` and `unicode_esc` differ between Python and the web raster. They are in `KNOWN_DIFFERENCES` in `web/tests/unit/parity.test.ts`. For `tab`, the auto-fit stops at size 79 in Python and at 81 in the web GUI. The cause of `unicode_esc` is not known.

**Note:** these tests run on Linux only. On macOS, use a container: `node:26-bookworm` works.

**Done when:** the cases are in the normal list, or a comment gives the cause and the reason to keep the difference.

## 14. Decide how `main` gets this work

**Decision for the user:** merge `tooling` into `main`, or make `tooling` the default branch.

**After the decision:** remove `tooling` from the deploy branches and from the `github-pages` environment, and update `CONTRIBUTING.md` and this file.

**Risk:** a merge to `main` makes later upstream merges harder, because all files are reformatted.

## 15. Split the work into upstream pull requests

**Do not start** before the user tells you to.

**Suggested order, from small to large:**

1. macOS connection: the retry, the log and the document. `macos-web-serial` has these changes.
2. Font list and Style list.
3. Fixes for the emoji print area, round letters and the length limit.
4. Tool changes. Ask upstream first, because the TypeScript and format changes touch nearly all files.

## Rejected

- **Automatic split of long labels:** the user decided against it. The length check stops bad prints, and a split by hand is fast. Also, flag pairs and the gaps between pairs use the same spaces, and several jobs waste about 2.6 cm of tape each.
- **Local Python bridge for printing:** it cannot operate from GitHub Pages.
