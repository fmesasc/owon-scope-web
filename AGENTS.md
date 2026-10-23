# Notes for coding agents

- Python package `owonscope/` (pyusb + numpy, stdlib HTTP server) and a static web UI in `owonscope/web/`
  (vanilla ES modules, no build step, no dependencies). The same UI runs on GitHub Pages (WebUSB) and from the
  local server, which injects `<meta name="owon-local-server">` into `index.html`.
- Protocol parsers exist twice and must stay in sync: `owonscope/legacy.py` + `owonscope/scpi.py` and
  `owonscope/web/protocols.js`.
- Legacy scopes: keep one USB session; never call SET_CONFIGURATION / CLEAR_HALT / reset on a working device
  (the firmware stops answering, and in WebUSB a reset makes Chrome lose the permission).
- Tests: `pytest` and `node --test tests/js/`. `tests/data/pds5022s_spbv01.bin` is a real PDS5022S dump.
- Pages deploy (`.github/workflows/pages.yml`) runs only after tests pass and adds `?v=<sha>` cache busting.
- Keep `llms.txt` up to date when supported models or the protocol notes change.
