import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing linked dist directory");
  try { fs.lstatSync(path.join(output, "data")); throw new Error("Refusing misplaced dist/data"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
} catch (error) { if (error.code !== "ENOENT") throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const common = { bundle: true, target: "es2022", minify: true, legalComments: "eof", absWorkingDir: root };
await build({ ...common, entryPoints: ["src/main.ts"], outfile: path.join(output, "main.js"), format: "esm", platform: "browser" });
await build({ ...common, entryPoints: ["src/backend.ts"], outfile: path.join(output, "backend.cjs"), format: "cjs", platform: "node" });
for (const name of ["manifest.json", "README.md", "LICENSE"]) fs.copyFileSync(path.join(root, name), path.join(output, name));
fs.copyFileSync(path.join(root, "src/styles.css"), path.join(output, "styles.css"));
fs.appendFileSync(path.join(output, "LICENSE"), "\n\nBundled backend dependency: TypeBox\n\n" + fs.readFileSync(path.join(root, "node_modules/typebox/license"), "utf8"));
console.log(`Built installable Vulpin plugin: ${output}`);
