// Fault-mode tests for dist/heating.js: bad price responses, relay errors,
// missing clock at boot, DST day with 25 hours. Run with `npm test`.
const fs = require("fs");
const code = fs.readFileSync("dist/heating.js", "utf8");

// ---- controllable fake Shelly
const F = { http: null, relayFail: -1, time: true };
let calls = [];
let loopFn, handler;

function csv(rows, start) {
  let s = "hdr\r\n";
  for (let i = 0; i < rows; i++) {
    s += `"${start + i * 900}";"x";"${(40 + Math.floor(i / 4)).toString()},50"\r\n`;
  }
  return s;
}

global.Shelly = {
  call(m, p, cb) {
    calls.push([m, p]);
    if (m === "KVS.Get") return cb({ value: '{"lim":8}' }, 0, "");
    if (m === "KVS.Set") return cb && cb({}, 0, "");
    if (m === "Switch.Set") return p.id === F.relayFail ? cb(null, -114, "fail") : cb({}, 0, "");
    if (m === "HTTP.GET") return F.http(p, cb);
    throw new Error("unexpected " + m);
  },
  getComponentStatus(c) { return c === "sys" ? { unixtime: F.time ? 1 : null } : { sta_ip: "x" }; },
  getCurrentScriptId() { return 1; }
};
global.Timer = { set(ms, r, fn) { loopFn = fn; } };
global.HTTPServer = { registerEndpoint(n, fn) { handler = fn; } };
console.log = (...a) => process.stdout.write("  [log] " + a.join(" ") + "\n");

const state = () => { let o; handler({ query: "r=s" }, { send() { o = this; } }); return JSON.parse(o.body); };
const switches = (on) => calls.filter((c) => c[0] === "Switch.Set" && c[1].on === on).length;
const todayMidnight = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() / 1000; };
let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.log("FAIL: " + msg); } }

function fresh(httpImpl) {
  calls = [];
  F.http = httpImpl;
  F.relayFail = -1;
  F.time = true;
  eval(code);
  for (let i = 0; i < 3; i++) loopFn();   // config, fetch today, decide
}

// 1. HTTP 500 -> no prices, outputs OFF
fresh((p, cb) => cb({ code: 500, body: "Internal Server Error" }, 0, ""));
let s = state();
check(s.p[0].length === 0 && s.on === false && s.err === 1, "http 500 -> off");
check(switches(false) === 3, "http 500 -> all three outputs off");

// 2. Empty body
fresh((p, cb) => cb({ code: 200, body: "" }, 0, ""));
s = state();
check(s.p[0].length === 0 && s.on === false, "empty body -> off");

// 3. Garbage body (HTML)
fresh((p, cb) => cb({ code: 200, body: "<html><body>maintenance</body></html>" }, 0, ""));
s = state();
check(s.p[0].length === 0 && s.on === false, "garbage body -> off");

// 4. Garbage rows mixed into valid data: bad rows skipped, 24 hours still parsed
fresh((p, cb) => cb({ code: 200, body: csv(96, todayMidnight()).replace('"x";"41,50"', '"x";"abc"') }, 0, ""));
s = state();
check(s.p[0].length === 24, "one bad row skipped, still 24 hours");

// 5. Relay failure on output 1: other outputs still set, error logged, retried next hour
fresh((p, cb) => cb({ code: 200, body: csv(96, todayMidnight()) }, 0, ""));
calls = [];
F.relayFail = 1;
handler({ query: "r=l&v=99" }, { send() {} });   // force ON decision
loopFn();
check(calls.filter((c) => c[0] === "Switch.Set").length === 3, "all three outputs attempted despite failure");
check(state().on === true, "commanded state recorded (note: not verified against relay)");

// 6. No clock at boot: outputs OFF once, no fetch; when clock appears -> fetch + decide
calls = [];
F.time = false;
eval(code);
for (let i = 0; i < 4; i++) loopFn();
check(calls.filter((c) => c[0] === "HTTP.GET").length === 0, "no fetch without clock");
check(switches(false) === 3, "outputs off once without clock");
F.time = true;
for (let i = 0; i < 3; i++) loopFn();
s = state();
check(s.p[0].length === 24 && s.time === true, "fetch + decide after clock sync");

// 7. DST autumn day: 100 quarter rows = 25 hours, must be accepted
fresh((p, cb) => cb({ code: 200, body: csv(100, todayMidnight()) }, 0, ""));
s = state();
check(s.p[0].length === 25, "25-hour day accepted");

// 8. Two hours' worth of data (Elering returning tomorrow's first rows only) -> rejected
fresh((p, cb) => cb({ code: 200, body: csv(8, todayMidnight()) }, 0, ""));
s = state();
check(s.p[0].length === 0 && s.on === false, "2 hours rejected");

// 9. Retry backoff: after a failure, no new fetch within the retry window
fresh((p, cb) => cb(null, -1, "timeout"));
calls = [];
for (let i = 0; i < 10; i++) loopFn();
check(calls.filter((c) => c[0] === "HTTP.GET").length === 0, "no refetch inside retry window");

console.log(failures ? `${failures} FAILED` : "faults ok");
process.exit(failures ? 1 : 0);
