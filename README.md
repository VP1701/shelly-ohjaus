# shelly-heating

Spot-price control for a hybrid oil/electric heating system on a
**Shelly Pro 3** (firmware 1.x). A stripped-down derivative of
[jisotalo/shelly-porssisahko](https://github.com/jisotalo/shelly-porssisahko).

## How it works

- The oil boiler runs on its own thermostat (65 °C) and is never controlled.
- The electric heater (thermostat 75 °C) is fed through outputs 0, 1 and 2.
  All three are switched together.
- Every hour the script compares the hour's average Nord Pool price for
  Finland (15‑minute prices averaged, Finnish VAT 25.5 % added) with the
  price limit. Price at or below the limit → outputs ON, otherwise OFF.
- If anything fails (no prices, no network, no clock, Elering down) the
  outputs are OFF and oil covers the heating.
- Prices come directly from the Elering CSV API, no registration needed.
  Tomorrow's prices are fetched after 15:00.
- The limit is stored in the Shelly KVS under key `heat` and survives reboots.

## Install

### Option A: from the Shelly script library (recommended)

1. Shelly web UI → **Scripts** → **Library** → **Configure URL** and enter

       https://raw.githubusercontent.com/<user>/shelly-ohjaus/main/shelly-library.json

   The repository must be public for the Shelly to fetch it.
2. The script appears in the library list. Press **Import code**, give it a
   name, save.
3. Enable **Run on startup**, press **Start**.
4. The script logs its URL, e.g. `http://192.168.1.50/script/1`. Open it in
   a browser on the same network to see prices and change the limit.

The Shelly copies the code at import time. To update, push a new
`dist/heating.js`, then import again from the library (replacing the old
script), and check that **Run on startup** is still enabled.

### Option B: paste manually

1. Shelly web UI → **Scripts** → **Add script**, paste the contents of
   `dist/heating.js`, save.
2. Continue from step 3 above.

### Device settings

- **Settings → Output settings** for outputs 0, 1 and 2: set *Initial state*
  to **Off**, so the heater is off between power-up and the script's first
  decision.
- If an older spot-price script is installed, stop it and disable its
  *Run on startup*; two scripts must not drive the same outputs.
- Optional watchdog: a schedule that calls `Script.Start` every hour restarts
  the script if it ever stopped (no effect while it runs). In a browser, with
  your script id:

       http://<ip>/rpc/Schedule.Create?timespec="0 5 * * * *"&calls=[{"method":"Script.Start","params":{"id":1}}]
## Web UI

- Current output state, current price, last fetch times, error count.
- Price limit field (c/kWh, VAT incl.) with Save. The new limit is applied
  within 10 seconds and also changes the planned marks for future hours.
- Today and tomorrow tables: hour, average price, and ✓ when electric
  heating is/was on. Past and current hours show what was actually done;
  future hours show the plan based on the current limit (italic).

## Build

`src/heating.js` is the script, `src/index.html` the UI. The build gzips
and base64‑encodes the UI into the script; the Shelly serves it with
`Content-Encoding: gzip`.

```
npm run build   # writes dist/heating.js
npm test        # build + mocked runtime tests (Node.js only)
```

`dist/heating.js` is committed so it can be pasted into a Shelly without Node.

## Resource use

Script source ~12 kB. Runtime keeps at most 48 `[epoch, price]` pairs
and a 24‑entry decision array. Only one asynchronous operation runs at a
time; while the script is fetching or switching, HTTP requests get 503 and
the UI retries. Outputs are set sequentially to stay well under the
5 concurrent RPC call limit.

## Notes

- Script memory on Shelly Gen2 devices is about 25 kB; keep additions small.
- The Elering API is only queried at most every 5 minutes on failure.
- Interpreter is Espruino‑based: use `function`, `let`, no arrow functions or
  array helpers like `map`, to stay safe.

## License

AGPL-3.0, like the project it is derived from.
