[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Aliffarhan782/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Aliffarhan782/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02 entry

A from-scratch Markdown-to-HTML renderer whose output is byte-for-byte
identical to marked 18.1.3 (`marked.parse` with default options: GFM on,
breaks off, pedantic off), but faster.

## Layout

- `parse.js` — the whole renderer, a dependency-free ES module exporting
  `parse(markdown)`. It works in three phases: a block phase that scans the
  document once with index-anchored patterns and builds the block tree
  (registering inline jobs as it goes), an inline phase that tokenizes each
  registered text run against a masked twin of itself (so emphasis scans
  never see delimiters inside links, code spans or html), and a rendering
  phase that walks the tree emitting HTML.
- `main.ts` — the harness driver: reads `cases.json` from the input
  directory (`/input`, or `$MAKEFUN_INPUT_DIR`), renders every case, and
  writes the HTML array to `html.json` in the output directory (`/output`,
  or `$MAKEFUN_OUTPUT_DIR`).

No dependencies; Node 22 built-ins only.
