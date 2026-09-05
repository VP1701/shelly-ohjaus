// Day rollover and "not yet published" paths, with a shiftable clock.
const fs = require("fs");
const code = fs.readFileSync("dist/heating.js", "utf8");
let offset = 0;
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [RealDate.now() + offset])); }
  static now() { return RealDate.now() + offset; }
};
function csv(dayOffset, rows) {
  const n = new Date();
  const start = new RealDate(n.getFullYear(), n.getMonth(), n.getDate() + dayOffset).getTime() / 1000;
  let s = 'hdr\n';
  for (let i = 0; i < rows; i++) s += `"${start + i * 900}";"x";"${dayOffset * 100 + Math.floor(i / 4)}"\n`;
  return s;
}
let rows = { 0: 96, 1: 96 };
const gets = [];
global.Shelly = {
  call(m, p, cb) {
    if (m === "KVS.Get") return cb({ value: '{"lim":12}' }, 0, "");
    if (m === "KVS.Set") return cb && cb({}, 0, "");
    if (m === "Switch.Set") return cb({}, 0, "");
    const n = new Date();
    const tmr = new RealDate(n.getFullYear(), n.getMonth(), n.getDate() + 1).toISOString();
    const d = p.url.includes(tmr) ? 1 : 0;
    gets.push(d);
    return cb({ code: 200, body: csv(d, rows[d]) }, 0, "");
  },
  getComponentStatus(c) { return c === "sys" ? { unixtime: 1 } : { sta_ip: "x" }; },
  getCurrentScriptId() { return 1; }
};
let loopFn, handler;
global.Timer = { set(ms, r, fn) { loopFn = fn; } };
global.HTTPServer = { registerEndpoint(n, fn) { handler = fn; } };
console.log = (...a) => process.stdout.write("  [log] " + a.join(" ") + "\n");
const st = () => { let o; handler({ query: "r=s" }, { send() { o = this; } }); return JSON.parse(o.body); };

// move clock to 16:00 today so tomorrow is fetched
const n = new Date();
offset = new RealDate(n.getFullYear(), n.getMonth(), n.getDate(), 16).getTime() - RealDate.now();
rows[1] = 40; // tomorrow not published yet
eval(code);
for (let i = 0; i < 4; i++) loopFn();
let s = st();
console.assert(s.p[0].length === 24 && s.p[1].length === 0 && s.err === 1, "tomorrow incomplete rejected");
for (let i = 0; i < 3; i++) loopFn();
console.assert(gets.length === 2, "no immediate retry: " + gets.length);
offset += 301e3; rows[1] = 96;
for (let i = 0; i < 3; i++) loopFn();
s = st();
console.assert(s.p[1].length === 24 && s.p[1][0][1] === 12.55, "tomorrow loaded after retry " + JSON.stringify(s.p[1][0]));
console.assert(s.on === true, "16:xx price 2.01 <= 12 -> on");

// roll over to tomorrow 00:00:05
gets.length = 0;
offset = new RealDate(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 5).getTime() - RealDate.now();
loopFn(); // rotation + decide in one tick? rotation, then ts[0] set -> decide
s = st();
console.assert(s.p[0][0][1] === 12.55 && s.p[1].length === 0 && gets.length === 0, "rotated without refetch");
console.assert(s.on === false && s.a[0] === 0 && s.a[1] === -1, "hour 0: 12.55 > 12 off, rest unknown");
loopFn();
s = st();
console.assert(s.day === new Date().getDate(), "day updated");
console.log("rollover ok");

// clock jump to a day with no data -> refetch path
offset += 2 * 864e5;
loopFn(); loopFn(); loopFn();
s = st();
console.assert(gets.length >= 1 && s.p[0].length === 24, "refetched after clock jump: " + gets.join());
console.log("all ok");
