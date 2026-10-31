# PT-P300BT Label Designer — Web

Browser version of the printlabel tool for the Brother PT-P300BT
label printer. It provides a HTML/CSS/JavaScript application to print over Bluetooth using the **Web Serial API**
(Bluetooth Classic RFCOMM/SPP).

## Installed fonts

Chrome and Edge can list the installed fonts. Click the font list (or **List installed fonts**) and allow the permission. The page then loads the list by itself on each visit. This needs HTTPS or `localhost`. Fonts that you activate in Font Book are included. A family with more than one style also shows a **Style** list, for example Bold. Other browsers show a curated list only: use **Load font file…** for other fonts.

## Files

| Path                 | Purpose                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `index.html`         | The application page.                                                                                                |
| `public/favicon.ico` | The application icon.                                                                                                |
| `src/app.ts`         | The GUI controller. It reads the controls, runs the live preview and starts a print.                                 |
| `src/label.ts`       | The label algorithms. They are a port of `printlabel.py`.                                                            |
| `src/printer.ts`     | The printer protocol and the Web Serial transport. They are a port of `ptcbp.py`, `ptstatus.py` and `labelmaker.py`. |
| `src/style.css`      | The theme.                                                                                                           |
| `tests/unit/`        | Vitest tests for the protocol, the label algorithms and the parity with Python.                                      |
| `tests/e2e/`         | Playwright tests for the page, with a mock serial port.                                                              |

## Running it

Web Serial needs a **secure context**. `file://` shows the preview, but the serial port does not operate. Run the page from a server:

```bash
mise run dev
# then open http://localhost:8000/ in Chrome or Edge
```

## Browser support

| Browser                       | Preview & algorithms | Bluetooth printing                                                             |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| Chrome / Edge (desktop, 117+) | ✅                   | ✅ (Web Serial + RFCOMM/SPP)                                                   |
| Chrome on Android             | ✅                   | ✅                                                                             |
| Firefox 155+ (desktop)        | ✅                   | ⚠️ (Web Serial present; RFCOMM/SPP support may vary — Chrome/Edge recommended) |
| Older Firefox                 | ✅                   | ❌ (no Web Serial)                                                             |
| Safari (macOS/iOS)            | ✅                   | ❌ (no Web Serial)                                                             |

The **"Web Serial available"** badge means the browser exposes the Web
Serial API with a working `requestPort()` (checked at runtime: Firefox
before v155 has no `navigator.serial` at all). Chrome and Edge are the
fully supported browsers for Bluetooth RFCOMM/SPP printing. On browsers
without Web Serial (older Firefox, Safari) the page shows the red
"unavailable" badge plus an informative banner — printing is disabled
there, but the preview and every label algorithm keep working.

When you press **Connect printer**, the browser shows its own permission
prompt ("… wants to connect to a serial port") listing the paired Bluetooth
devices that expose the SPP service; the page requests the standard SPP
service class UUID (`00001101-…`), which is how Chrome reaches Bluetooth
Classic RFCOMM devices without an OS serial port.

On macOS, choose the entry **without** `cu.` in the chooser. The `cu.` port does
not reach the printer. The first Bluetooth attempt can take 10 s and fail. The
page then retries by itself, and the retry connects while the link is up.

## Tests

Refer to [CONTRIBUTING.md](../CONTRIBUTING.md).
