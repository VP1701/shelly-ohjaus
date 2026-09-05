// Builds dist/heating.js from src/. No dependencies beyond Node.js.
// The UI is gzipped and base64 encoded into the script; the Shelly serves
// it with Content-Encoding: gzip so the browser unpacks it.
const fs = require("fs");
const zlib = require("zlib");

const html = fs.readFileSync("src/index.html", "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
const gz = zlib.gzipSync(html, { level: 9 }).toString("base64");

const src = fs.readFileSync("src/heating.js", "utf8");
if (!src.includes("#[index.html]")) {
  throw new Error("placeholder #[index.html] missing from src/heating.js");
}
const out = src.replace("#[index.html]", gz);

fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/heating.js", out);

console.log(`index.html ${html.length} B -> gzip+base64 ${gz.length} B`);
console.log(`dist/heating.js ${out.length} B`);
