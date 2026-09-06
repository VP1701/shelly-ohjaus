/**
 * shelly-heating
 *
 * Turns the electric heater (outputs 0, 1, 2 = three phases) on when the
 * Nord Pool hourly average price (VAT incl.) is at or below a limit.
 * Oil heating runs on its own thermostat and is never touched, so any
 * failure (no prices, no network, no clock) simply means outputs OFF.
 *
 * Price data: Elering CSV API (15-minute rows, averaged per hour).
 * Derived from jisotalo/shelly-porssisahko (AGPL-3.0).
 *
 * Do not edit dist/heating.js by hand: edit src/ and run `npm run build`.
 */

const VAT = 25.5;                 // Finnish VAT %
const OUTPUTS = [0, 1, 2];        // relays feeding the heater phases
const KVS_KEY = "heat";           // settings key in Shelly KVS
const TOMORROW_HOUR = 15;         // local hour after which tomorrow is fetched
const RETRY_S = 300;              // wait between failed fetch attempts
const LOOP_MS = 10000;

// Runtime state. Kept flat and small on purpose (25 kB script RAM).
let S = {
  lim: 10,        // price limit c/kWh, VAT incl. (from KVS)
  on: null,      // last command sent to outputs
  hr: -1,         // local hour the last decision was made for
  day: 0,         // day of month that P[0] belongs to
  ts: [0, 0],     // fetch time of today / tomorrow prices, 0 = not loaded
  retry: 0,       // epoch before which no fetch is attempted
  err: 0,         // failed fetches since start
  cfg: false,     // settings loaded from KVS
  time: false     // NTP time valid
};
let P = [[], []];                 // 24 x [hourEpoch, price] for today / tomorrow
let A = [];                       // decisions made today, index = hour (0/1)
let busy = false;

function log(s) {
  console.log("heating: " + s);
}

function epoch() {
  return Math.floor(Date.now() / 1000);
}

function done() {
  busy = false;
}

function clearToday() {
  A = [];
  for (let i = 0; i < 24; i++) {
    A.push(-1);
  }
  S.hr = -1;
}

// ---------------------------------------------------------------- settings

function getConfig() {
  Shelly.call("KVS.Get", { key: KVS_KEY }, function (res, err) {
    if (err === 0 && res && res.value) {
      let c = JSON.parse(res.value);
      if (typeof c.lim === "number") {
        S.lim = c.lim;
      }
    } else {
      saveConfig();
    }
    S.cfg = true;
    log("limit " + S.lim + " c/kWh");
    done();
  });
}

function saveConfig() {
  Shelly.call("KVS.Set", { key: KVS_KEY, value: JSON.stringify({ lim: S.lim }) });
}

// ---------------------------------------------------------------- prices

/**
 * Fetches prices for day d (0 = today, 1 = tomorrow) and averages the
 * 15-minute rows into hours. Parsing is done with indexOf/substring on the
 * body so no per-row arrays are created.
 */
function midnight(ms) {
  let t = new Date(ms);
  return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
}

function getPrices(d) {
  let start = midnight(Date.now());
  if (d === 1) {
    start = midnight(start + 36 * 3600 * 1000);
  }
  let end = midnight(start + 36 * 3600 * 1000) - 1000;   // DST safe
  let req = {
    url: "https://dashboard.elering.ee/api/nps/price/csv?fields=fi&start="
      + new Date(start).toISOString() + "&end=" + new Date(end).toISOString(),
    timeout: 5,
    ssl_ca: "*"
  };
  let day = new Date(start).getDate();
  start = null;
  end = null;

  Shelly.call("HTTP.GET", req, function (res, err, msg) {
    req = null;
    let ok = false;

    try {
      if (err !== 0 || !res || res.code !== 200) {
        throw new Error("http " + err + " " + msg + " " + (res ? res.code : ""));
      }
      let b = res.body_b64 ? atob(res.body_b64) : res.body;
      res = null;

      let out = [];
      let i = b.indexOf("\n") + 1;   // skip header
      let cur = -1;                  // hour bucket (epoch / 3600)
      let sum = 0;
      let cnt = 0;

      while (i > 0 && i < b.length) {
        let e = b.indexOf("\n", i);
        if (e < 0) {
          e = b.length;
        }
        let line = b.substring(i, e);
        i = e + 1;
        if (line.length < 10) {
          continue;
        }
        // "epoch";"dd.mm.yyyy hh:mm";"price,with,comma"
        let ts = Number(line.substring(1, line.indexOf("\"", 1)));
        let pr = Number(line.substring(line.lastIndexOf(";") + 2,
          line.lastIndexOf("\"")).replace(",", "."));
        line = null;
        if (isNaN(ts) || isNaN(pr)) {
          continue;
        }
        pr = pr / 10;                             // EUR/MWh -> c/kWh
        if (pr > 0) {
          pr = pr * (100 + VAT) / 100;
        }
        let hb = Math.floor(ts / 3600);
        if (hb !== cur) {
          if (cnt > 0) {
            out.push([cur * 3600, Math.round(sum / cnt * 100) / 100]);
          }
          cur = hb;
          sum = 0;
          cnt = 0;
        }
        sum += pr;
        cnt++;
      }
      if (cnt > 0) {
        out.push([cur * 3600, Math.round(sum / cnt * 100) / 100]);
      }
      b = null;

      // 23-25 hours allowed for DST days; fewer means not published yet
      if (out.length < 23) {
        throw new Error("only " + out.length + " hours");
      }

      P[d] = out;
      S.ts[d] = epoch();
      S.retry = 0;
      if (d === 0) {
        S.day = day;
        S.hr = -1;   // decide again with fresh prices
      }
      ok = true;
      log("prices for day " + d + ": " + out.length + " hours");
    } catch (ex) {
      log("price fetch failed: " + ex);
    }

    if (!ok) {
      P[d] = [];
      S.ts[d] = 0;
      S.err++;
      S.retry = epoch() + RETRY_S;
      if (d === 0) {
        S.hr = -1;   // no prices -> decision must run and turn OFF
      }
    }
    done();
  });
}

/** Price for the current hour, or null if unknown. */
function currentPrice() {
  let now = epoch();
  for (let i = 0; i < P[0].length; i++) {
    let diff = now - P[0][i][0];
    if (diff >= 0 && diff < 3600) {
      return P[0][i][1];
    }
  }
  if (P[0].length > 0) {
    // Prices loaded but not for this hour: clock or date was wrong.
    log("current hour not in price data, refetching");
    P[0] = [];
    S.ts[0] = 0;
    S.retry = epoch() + RETRY_S;
  }
  return null;
}

// ---------------------------------------------------------------- control

/** Sets all outputs to the same state one after another, then cb(). */
function setOutputs(on, cb) {
  let i = 0;
  function next(res, err, msg) {
    if (err) {
      log("Switch.Set failed: " + err + " " + msg);
    }
    if (i >= OUTPUTS.length) {
      S.on = on;
      cb();
      return;
    }
    i++;
    Shelly.call("Switch.Set", { id: OUTPUTS[i - 1], on: on }, next);
  }
  next(null, 0, "");
}

function decide(now) {
  let h = now.getHours();
  let pr = currentPrice();
  let on = pr !== null && pr <= S.lim;
  S.hr = h;
  A[h] = on ? 1 : 0;
  log("hour " + h + " price " + pr + " limit " + S.lim + " -> " + (on ? "ON" : "OFF"));
  setOutputs(on, done);
}

/** Runs every LOOP_MS. Does at most one asynchronous thing per tick. */
function loop() {
  if (busy) {
    return;
  }
  busy = true;
  try {
    let now = new Date();
    S.time = Shelly.getComponentStatus("sys").unixtime != null
      && now.getFullYear() > 2000;

    if (!S.cfg) {
      getConfig();
      return;
    }
    if (!S.time) {
      // Outputs may have restored ON after a power cut: assert OFF once.
      if (S.on !== false || S.hr !== -1) {
        S.hr = -1;
        setOutputs(false, done);
      } else {
        done();
      }
      return;
    }

    // Day changed: yesterday's tomorrow becomes today.
    let d = now.getDate();
    if (S.day !== 0 && S.day !== d) {
      P[0] = P[1];
      P[1] = [];
      S.ts[0] = S.ts[1];
      S.ts[1] = 0;
      S.day = d;
      clearToday();
    }

    let canFetch = epoch() >= S.retry;
    if (S.ts[0] === 0 && canFetch) {
      getPrices(0);
      return;
    }
    if (S.ts[1] === 0 && canFetch && now.getHours() >= TOMORROW_HOUR) {
      getPrices(1);
      return;
    }
    if (now.getHours() !== S.hr) {
      decide(now);
      return;
    }
    done();
  } catch (ex) {
    log("loop error: " + ex);
    done();
  }
}

// ---------------------------------------------------------------- http

/** Returns value of query parameter k from "a=1&b=2", or "". */
function param(q, k) {
  q = "&" + q;
  let i = q.indexOf("&" + k + "=");
  if (i < 0) {
    return "";
  }
  i += k.length + 2;
  let e = q.indexOf("&", i);
  return q.substring(i, e < 0 ? q.length : e);
}

function onRequest(req, res) {
  if (busy) {
    // Saves memory: fetching/parsing and serving at the same time can OOM.
    req = null;
    res.code = 503;
    res.send();
    return;
  }
  let q = req.query || "";
  req = null;
  let r = param(q, "r");
  res.code = 200;

  if (r === "l") {
    let v = Number(param(q, "v"));
    if (!isNaN(v) && v > -100 && v < 1000) {
      S.lim = Math.round(v * 100) / 100;
      saveConfig();
      S.hr = -1;   // apply immediately on next tick
      log("limit set to " + S.lim);
    }
    r = "s";
  }

  if (r === "s") {
    res.headers = [["Content-Type", "application/json"]];
    res.body = JSON.stringify({
      lim: S.lim, on: S.on, time: S.time, ts: S.ts, err: S.err,
      day: S.day, p: P, a: A
    });
  } else {
    res.headers = [["Content-Type", "text/html"], ["Content-Encoding", "gzip"]];
    res.body = atob("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");
  }
  res.send();
}

// ---------------------------------------------------------------- start

clearToday();
log("URL: http://" + (Shelly.getComponentStatus("wifi").sta_ip ?? "?")
  + "/script/" + Shelly.getCurrentScriptId());
HTTPServer.registerEndpoint("", onRequest);
Timer.set(LOOP_MS, true, loop);
loop();
