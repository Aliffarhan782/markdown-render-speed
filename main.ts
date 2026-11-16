// Driver for the markdown-render-speed-02 harness.
//
// Reads every case from cases.json in the input directory, renders each
// case's markdown with parse() from ./parse.js, and writes the HTML strings,
// in the same order, as a JSON array to html.json in the output directory.
//
// The directories default to /input and /output and can be overridden with
// the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment variables.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8")) as Case[];

const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
