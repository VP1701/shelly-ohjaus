// Local simulator for dist/heating.js.
//
//   node dev/server.js            real Elering prices, UI at http://localhost:8080
//   node dev/server.js --fake     synthetic prices, no network needed
//   node dev/server.js --port 9000
//
// Relay switching is printed to the console instead of driving hardware.
// The price limit is persisted in dev/kvs.json (the Shelly's KVS).
//
// Fault injection while running (open in a browser or curl):
//   http://localhost:8080/fault                 show current faults
//   http://localhost:8080/fault?fail=1          HTTP.GET times out
//   http://localhost:8080/fault?http500=1       Elering answers HTTP 500
//   http://localhost:8080/fault?partial=1       only 10 hours of data (not published yet)
//   http://localhost:8080/fault?garbage=1       body is HTML instead of CSV
//   http://localhost:8080/fault?relayfail=1     Switch.Set fails for output 1 (0/1/2, -1 = none)
//   http://localhost:8080/fault?notime=1        Shelly clock not synced
//   http://localhost:8080/fault?refetch=1       forget prices so the next tick fetches again
// Set a value to 0 to clear it. Several can be combined with &.
const fs = require("fs");
const http = require("http");
const path = require("path");

const args = process.argv.slice(2);
const FAKE = args.includes("--fake");
const PORT = Number(args[args.indexOf("--port") + 1]) || 8080;
const KVS_FILE = path.join(__dirname, "kvs.json");
const code = fs.readFileSync(path.join(__dirname, "..", "dist", "heating.js"), "utf8");

const stamp = () => new Date().toTimeString().slice(0, 8);
const fault = { fail: 0, http500: 0, partial: 0, garbage: 0, relayfail: -1, notime: 0 };
const relays = [false, false, false];
let kvs = {};
try {
  kvs = JSON.parse(fs.readFileSync(KVS_FILE, "utf8"));
} catch (e) {
  // first run
}

function fakeCsv(url) {
  const start = Number(new Date(url.match(/start=([^&]+)/)[1])) / 1000;
  let s = '"Ajatempel (UTC)";"Kuupäev (Eesti aeg)";"NPS Soome"\r\n';
  for (let i = 0; i < (fault.partial ? 40 : 96); i++) {
    const h = Math.floor(i / 4);
    // cheap at night, expensive morning/evening, negative at 03
    const eur = h === 3 ? -4 : 20 + 90 * Math.max(0, Math.sin((h - 5) / 24 * 2 * Math.PI)) + (i % 4) * 2;
    s += `"${start + i * 900}";"x";"${eur.toFixed(2).replace(".", ",")}"\r\n`;
  }
  return s;
}

global.Shelly = {
  call(method, params, cb) {
    switch (method) {
      case "KVS.Get":
        return setImmediate(() => kvs[params.key] !== undefined
          ? cb({ value: kvs[params.key] }, 0, "")
          : cb(null, -105, "not found"));
      case "KVS.Set":
        kvs[params.key] = params.value;
        fs.writeFileSync(KVS_FILE, JSON.stringify(kvs, null, 2));
        return cb && setImmediate(() => cb({}, 0, ""));
      case "Switch.Set":
        if (params.id === fault.relayfail) {
          console.log(`${stamp()}  RELAY ${params.id} -> FAILED (injected)`);
          return setImmediate(() => cb(null, -114, "injected failure"));
        }
        relays[params.id] = params.on;
        console.log(`${stamp()}  RELAY ${params.id} -> ${params.on ? "ON " : "OFF"}   [${relays.map((r) => (r ? "1" : "0")).join("")}]`);
        return setImmediate(() => cb({}, 0, ""));
      case "HTTP.GET":
        console.log(`${stamp()}  GET ${params.url}`);
        if (fault.fail) {
          return setTimeout(() => cb(null, -1, "injected timeout"), 500);
        }
        if (fault.http500) {
          return setTimeout(() => cb({ code: 500, body: "Internal Server Error" }, 0, ""), 300);
        }
        if (fault.garbage) {
          return setTimeout(() => cb({ code: 200, body: "<html><body>maintenance</body></html>" }, 0, ""), 300);
        }
        if (FAKE || fault.partial) {
          return setTimeout(() => cb({ code: 200, body: fakeCsv(params.url) }, 0, ""), 300);
        }
        return fetch(params.url, { signal: AbortSignal.timeout(params.timeout * 1000) })
          .then((r) => r.text().then((t) => cb({ code: r.status, body: t }, 0, "")))
          .catch((e) => cb(null, -1, String(e)));
      default:
        throw new Error("unmocked RPC " + method);
    }
  },
  getComponentStatus(c) {
    if (c === "sys") {
      return { unixtime: fault.notime ? null : Math.floor(Date.now() / 1000) };
    }
    return { sta_ip: "localhost:" + PORT };
  },
  getCurrentScriptId: () => 1
};
// Faster ticks than the real 10 s so the UI fills in within seconds.
global.Timer = { set: (ms, repeat, fn) => (repeat ? setInterval(fn, Math.min(ms, 2000)) : setTimeout(fn, ms)) };
let handler = null;
global.HTTPServer = { registerEndpoint: (name, fn) => { handler = fn; } };

// let/const inside eval stay private; make S a var so /fault?refetch can reach it.
eval(code.replace("let S = {", "var S = {"));   // runs the script

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/fault") {
    for (const [k, v] of url.searchParams) {
      if (k === "refetch" && v === "1") {
        S.ts = [0, 0];      // script state, visible because the script ran via eval
        S.retry = 0;
        console.log(`${stamp()}  FAULT refetch forced`);
      } else if (k in fault) {
        fault[k] = Number(v);
        console.log(`${stamp()}  FAULT ${k} = ${fault[k]}`);
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(fault, null, 2));
  }
  if (url.pathname !== "/") {
    res.writeHead(404);
    return res.end();
  }
  const shellyRes = {
    code: 200,
    headers: [],
    body: "",
    send() {
      const h = Object.fromEntries(this.headers);
      // atob() gives a binary string; latin1 turns it back into the gzip bytes
      res.writeHead(this.code, h);
      res.end(Buffer.from(this.body, "latin1"));
    }
  };
  handler({ query: url.search.slice(1) }, shellyRes);
}).listen(PORT, () => {
  console.log(`\nUI: http://localhost:${PORT}/   (${FAKE ? "fake prices" : "real Elering prices"})\n`);
});
