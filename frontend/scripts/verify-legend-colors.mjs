#!/usr/bin/env node
/**
 * Standalone verification script for legend/canvas color parity (issue #49).
 *
 * The Graph tab's legend swatches (`src/App.css`) are plain hand-authored
 * CSS, independent of `src/graph/colors.ts`'s `COLORS` object — the single
 * source of truth for the actual canvas node/edge colors drawn by
 * `draw-agents.ts`/`draw-edges.ts` via `agentColors()`. Nothing enforces
 * that the two stay in sync, which is exactly how they drifted before this
 * issue (`.graph-swatch--stopped` stayed hardcoded gray after #40 moved the
 * real stopped-agent color to green). This script re-derives both sides
 * from their real source files (rather than duplicating literal color
 * values here) and diffs them, per the repo's convention of small
 * standalone `.mjs` verification scripts (see verify-layout.mjs) for pure
 * logic with no test runner wired in yet — run with
 * `node scripts/verify-legend-colors.mjs` from `frontend/`.
 *
 * Exits non-zero (and prints which pairing failed) on any mismatch.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const colorsSrc = readFileSync(path.join(__dirname, '../src/graph/colors.ts'), 'utf8')
const cssSrc = readFileSync(path.join(__dirname, '../src/App.css'), 'utf8')

function extractColor(name) {
  const m = colorsSrc.match(new RegExp(`${name}:\\s*'([^']+)'`))
  if (!m) throw new Error(`could not find ${name} in colors.ts`)
  return m[1]
}

function extractSwatchColor(selector, prop) {
  const block = cssSrc.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))
  if (!block) throw new Error(`could not find ${selector} in App.css`)
  const m = block[1].match(new RegExp(`${prop}:\\s*([^;]+);`))
  if (!m) throw new Error(`could not find ${prop} in ${selector}`)
  return m[1].trim()
}

// Normalize so e.g. "#16a34a" and "rgb(22, 163, 74)" would still compare
// meaningfully if either side ever changes representation — for now both
// sides use identical hex/rgba literal syntax, so a straight string compare
// after whitespace-normalizing is sufficient and avoids pulling in a color
// parsing dependency for this small a script.
function normalize(color) {
  return color.replace(/\s+/g, ' ').trim().toLowerCase()
}

const pairings = [
  { legend: '.graph-swatch--stopped', prop: 'background', colorsKey: 'stoppedStroke' },
  { legend: '.graph-swatch--error', prop: 'background', colorsKey: 'errorStroke' },
  { legend: '.graph-swatch--stale', prop: 'background', colorsKey: 'staleStroke' },
  { legend: '.graph-edge-swatch', prop: 'background', colorsKey: 'edgePending' },
  { legend: '.graph-edge-swatch--settled', prop: 'background', colorsKey: 'edgeSettled' },
]

let failures = 0

for (const { legend, prop, colorsKey } of pairings) {
  const cssColor = normalize(extractSwatchColor(legend, prop))
  const expected = normalize(extractColor(colorsKey))
  const ok = cssColor === expected
  console.log(
    `${ok ? 'PASS' : 'FAIL'}: ${legend} { ${prop} } is "${cssColor}", expected COLORS.${colorsKey} = "${expected}"`,
  )
  if (!ok) failures++
}

// .graph-swatch--running is intentionally left out of `pairings` above (it
// already matched pre-#49 and needed no fix), but it's still worth a
// standing check so a future edit to either file can't silently reintroduce
// drift there too.
{
  const cssColor = normalize(extractSwatchColor('.graph-swatch--running', 'background'))
  const expected = normalize(extractColor('runningStroke'))
  const ok = cssColor === expected
  console.log(
    `${ok ? 'PASS' : 'FAIL'}: .graph-swatch--running { background } is "${cssColor}", expected COLORS.runningStroke = "${expected}"`,
  )
  if (!ok) failures++
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll legend color checks passed.')
}
