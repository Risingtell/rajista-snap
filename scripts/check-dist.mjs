// Refuses to deploy a build that contains anything shaped like an App Check debug token (a v4 UUID), or the
// debug-token variable itself. Run by `npm run deploy` after the build.
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const bad = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|html|json|webmanifest|txt)$/.test(f)) {
      const text = fs.readFileSync(p, "utf8");
      if (uuid.test(text) || text.includes("VITE_APPCHECK_DEBUG_TOKEN")) bad.push(path.relative(dist, p));
    }
  }
};
walk(dist);
if (bad.length) {
  console.error(`check-dist: refusing to deploy, token-like text found in: ${bad.join(", ")}`);
  process.exit(1);
}
console.log("check-dist: no debug token in the build");
