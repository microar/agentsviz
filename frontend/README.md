# AgentsViz Frontend

React + Vite (TypeScript) frontend for AgentsViz. Currently a bare scaffold with static
placeholders for the Graph, Logs, and Teams views — no live data wired up yet.

## Getting started

```bash
npm install
npm run dev
```

The dev server prints a local URL (defaults to http://localhost:5173).

## Scripts

- `npm run dev` — start the local dev server with HMR
- `npm run build` — type-check and build a production bundle to `dist/`
- `npm run preview` — preview the production build locally
- `npm run lint` — run oxlint

## Configuration

Build-time env vars (Vite — set in the shell or a `.env` file, read at
build time):

| Variable | Default | Description |
|---|---|---|
| `VITE_WS_URL` | derived from `window.location` + port `4000` | WebSocket URL to connect to. |
| `VITE_AGENTSVIZ_TOKEN` | `dev-local-token` | Viewer token (issue #52) sent as `?token=` on the `/ws` handshake and as `Authorization: Bearer` on the `/events/history` fetch. The default matches the server's built-in dev token, so local `npm run dev` needs no setup; set this to a value in the server's `AGENTSVIZ_API_KEYS` for a locked-down deployment. |
