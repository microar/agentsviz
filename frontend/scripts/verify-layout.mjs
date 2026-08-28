#!/usr/bin/env node
/**
 * Standalone verification script for the phyllotaxis layout (issue #45).
 *
 * There's no component-test runner wired into `frontend/` yet, but pure
 * layout math like this is a good candidate for a quick programmatic check
 * (see the repo's convention of small standalone `.mjs`/`.ts` verification
 * scripts) — run with `node scripts/verify-layout.mjs` from `frontend/`.
 *
 * It re-derives the layout constants straight from `src/graph/layout.ts`
 * (via a small regex extraction, rather than duplicating literal numbers
 * here) so this script can't silently drift out of sync with the real
 * values, then checks:
 *
 *  1. No two agent nodes (or two tool nodes) in the same phyllotaxis spiral
 *     ever overlap, for every pairwise combination of indices 0..N (not
 *     just adjacent indices — the golden-angle spiral can place
 *     non-adjacent indices close together at certain angles/radii too).
 *  2. The agent cluster and tool cluster don't overlap each other at
 *     realistic/high concurrent node counts.
 *
 * Exits non-zero (and prints which check failed) if either invariant is
 * violated, so it can be wired into CI later if a real test runner shows
 * up.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const layoutSrc = readFileSync(path.join(__dirname, '../src/graph/layout.ts'), 'utf8')

function extractNumber(name) {
  const m = layoutSrc.match(new RegExp(`export const ${name}\\s*=\\s*([\\d.]+)`))
  if (!m) throw new Error(`could not find ${name} in layout.ts`)
  return Number(m[1])
}

function extractPoint(name) {
  const m = layoutSrc.match(new RegExp(`export const ${name}: Point = \\{ x: ([\\d.]+), y: ([\\d.]+) \\}`))
  if (!m) throw new Error(`could not find ${name} in layout.ts`)
  return { x: Number(m[1]), y: Number(m[2]) }
}

const AGENT_SPACING = extractNumber('AGENT_SPACING')
const TOOL_SPACING = extractNumber('TOOL_SPACING')
const AGENT_RADIUS = extractNumber('AGENT_RADIUS')
const TOOL_SIZE = extractNumber('TOOL_SIZE')
const AGENT_CENTER = extractPoint('AGENT_CENTER')
const TOOL_CENTER = extractPoint('TOOL_CENTER')

// Bounding-circle radius of a square tool node (worst case: the diagonal),
// so the "no overlap" check is conservative rather than assuming axis
// alignment saves it.
const TOOL_RADIUS = (TOOL_SIZE / 2) * Math.SQRT2

const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5))

function phyllotaxisPoint(index, center, spacing) {
  const angle = index * GOLDEN_ANGLE_RAD
  const radius = spacing * Math.sqrt(index)
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

const MAX_INDEX = 50 // "realistic range of node counts" per the issue
let failures = 0

function checkNoOverlap(label, center, spacing, nodeRadius) {
  const points = []
  for (let i = 0; i <= MAX_INDEX; i++) points.push(phyllotaxisPoint(i, center, spacing))

  let minDist = Infinity
  let minPair = null
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = dist(points[i], points[j])
      if (d < minDist) {
        minDist = d
        minPair = [i, j]
      }
    }
  }

  const required = 2 * nodeRadius
  const ok = minDist > required
  console.log(
    `${ok ? 'PASS' : 'FAIL'}: ${label} — min pairwise distance across indices 0..${MAX_INDEX} is ` +
      `${minDist.toFixed(2)}px (indices ${minPair}), must exceed 2*radius = ${required}px`,
  )
  if (!ok) failures++
}

function checkClusterSeparation() {
  let agentMaxReach = 0
  let toolMaxReach = 0
  for (let i = 0; i <= MAX_INDEX; i++) {
    agentMaxReach = Math.max(agentMaxReach, AGENT_SPACING * Math.sqrt(i) + AGENT_RADIUS)
    toolMaxReach = Math.max(toolMaxReach, TOOL_SPACING * Math.sqrt(i) + TOOL_RADIUS)
  }
  const centerDist = dist(AGENT_CENTER, TOOL_CENTER)
  const ok = agentMaxReach + toolMaxReach < centerDist
  console.log(
    `${ok ? 'PASS' : 'FAIL'}: agent/tool cluster separation at up to ${MAX_INDEX} nodes each — ` +
      `agent cluster reaches ${agentMaxReach.toFixed(1)}px, tool cluster reaches ${toolMaxReach.toFixed(1)}px, ` +
      `center distance is ${centerDist.toFixed(1)}px`,
  )
  if (!ok) failures++
}

console.log(`Layout constants: AGENT_SPACING=${AGENT_SPACING} AGENT_RADIUS=${AGENT_RADIUS} ` +
  `TOOL_SPACING=${TOOL_SPACING} TOOL_SIZE=${TOOL_SIZE}`)
console.log(`Centers: AGENT_CENTER=(${AGENT_CENTER.x},${AGENT_CENTER.y}) TOOL_CENTER=(${TOOL_CENTER.x},${TOOL_CENTER.y})\n`)

checkNoOverlap('agent nodes', AGENT_CENTER, AGENT_SPACING, AGENT_RADIUS)
checkNoOverlap('tool nodes', TOOL_CENTER, TOOL_SPACING, TOOL_RADIUS)
checkClusterSeparation()

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
} else {
  console.log('\nAll layout checks passed.')
}
