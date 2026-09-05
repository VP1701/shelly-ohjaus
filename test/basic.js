// Mock Shelly runtime and exercise the script logic.
const fs = require("fs");
let code = fs.readFileSync("dist/heating.js", "utf8");

// --- synthetic Elering CSV: 96 rows for today, price = hour EUR/MWh*10-ish
function csv(dayOffset, rows = 96) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset).getTime() / 1000;
  let s = '"Ajatempel (UTC)";"Kuupäev (Eesti aeg)";"NPS Soome"\r\n';
  for (let i = 0; i < rows; i++) {
    const ts = start + i * 900;
    const h = Math.floor(i / 4);
    // hour h price in EUR/MWh, with a negative hour at 3 and quarter variation
    const eur = h === 3 ? -5 : h * 10 + (i % 4);
    s += `"${ts}";"x";"${String(eur).replace(".", ",")}"\r\n`;
  }
  return s;
}

const calls = [];
let kvs = null;
let httpRows = 96;
let httpFail = false;
global.Shelly = {
  call(m, p, cb) {
    calls.push([m, JSON.stringify(p)]);
    if (m === "KVS.Get") return cb(kvs ? { value: kvs } : null, kvs ? 0 : -105, "");
    if (m === "KVS.Set") { kvs = p.value; return cb && cb({}, 0, ""); }
    if (m === "Switch.Set") return cb({ was_on: false }, 0, "");
    if (m === "HTTP.GET") {
      const d = p.url.includes(new Date(Date.now() + 864e5).toISOString().slice(0, 10)) ? 1 : 0;
      if (httpFail) return cb(null, -1, "timeout");
      const body = csv(d, httpRows);
      return cb({ code: 200, body_b64: Buffer.from(body, "latin1").toString("base64") }, 0, "");
    }
    throw new Error("unexpected " + m);
  },
  getComponentStatus(c) { return c === "sys" ? { unixtime: 1 } : { sta_ip: "1.2.3.4" }; },
  getCurrentScriptId() { return 1; }
};
let loopFn = null;
global.Timer = { set(ms, rep, fn) { loopFn = fn; } };
let handler = null;
global.HTTPServer = { registerEndpoint(n, fn) { handler = fn; } };
global.console.log = (...a) => process.stdout.write("  [log] " + a.join(" ") + "\n");

// module scoping: run in this context so we can reach the handler
eval(code);

function tick(n = 1) { for (let i = 0; i < n; i++) loopFn(); }
function state(q) {
  let out;
  handler({ query: q }, { send() { out = this; } });
  return out;
}

tick(3); // config -> today -> decide
let s = JSON.parse(state("r=s").body);
const h = new Date().getHours();
console.assert(s.p[0].length === 24, "24 hours parsed");
console.assert(s.p[0][3][1] < 0 && Math.abs(s.p[0][3][1] - (-0.5)) < 1e-9, "negative hour, no VAT: " + s.p[0][3][1]);
const exp5 = (50 + 1.5) / 10 * 1.255;
console.assert(Math.abs(s.p[0][5][1] - Math.round(exp5 * 100) / 100) < 1e-9, "hour 5 avg+VAT " + s.p[0][5][1]);
console.assert(s.a[h] === (s.p[0][h][1] <= 10 ? 1 : 0), "decision recorded");
console.assert(calls.filter(c => c[0] === "Switch.Set").length === 3, "three outputs set");
console.log("today ok, hour", h, "price", s.p[0][h][1], "on", s.on);

// limit change via UI
calls.length = 0;
s = JSON.parse(state("r=l&v=99.5").body);
console.assert(s.lim === 99.5 && JSON.parse(kvs).lim === 99.5, "limit saved");
tick();
console.assert(calls.filter(c => c[0] === "Switch.Set" && c[1].includes("true")).length === 3, "re-decided ON");
s = JSON.parse(state("r=s").body);
console.assert(s.a[h] === 1 && s.on === true, "actual updated");
console.log("limit change ok");

// bad param ignored
s = JSON.parse(state("r=l&v=abc").body);
console.assert(s.lim === 99.5, "bad value ignored");

// tomorrow not yet published (fewer rows) -> retry, not stored
httpRows = 40;
tick(); // no-op if hour < 15; force by faking hour check? just verify no crash
s = JSON.parse(state("r=s").body);
console.log("tomorrow loaded:", s.p[1].length, "(0 expected unless >=15:00 and rows ok)");

// fetch failure -> outputs OFF
httpFail = true;
eval(code.replace(/^/, "")); // fresh instance
calls.length = 0;
tick(3);
s = JSON.parse(state("r=s").body);
console.assert(s.p[0].length === 0 && s.on === false && s.err === 1, "failure -> off");
console.assert(calls.filter(c => c[0] === "Switch.Set" && c[1].includes("false")).length === 3, "outputs off on failure");
tick(3);
console.assert(calls.filter(c => c[0] === "HTTP.GET").length === 1, "no refetch before retry window");
console.log("failure path ok");

// html endpoint
const html = state("");
console.assert(html.headers[1][1] === "gzip" && html.body.length > 1000, "html served");
console.log("all tests done");
