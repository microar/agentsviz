/**
 * Short display labels for agent / tool ids in the Graph tab.
 *
 * Extracted from the (now removed) canvas `layout.ts` in issue #87 when the
 * Graph tab moved to React Flow (`GraphFlow.tsx`). The truncation rules are
 * unchanged from the canvas renderer so node captions read identically, and
 * `App.tsx`'s Session dropdown (which also calls `agentLabel`) keeps working
 * without change.
 */

export function agentLabel(agentId: string): string {
  return agentId.length > 14 ? `${agentId.slice(0, 13)}…` : agentId
}

export function toolLabel(tool: string): string {
  return tool.length > 12 ? `${tool.slice(0, 11)}…` : tool
}
