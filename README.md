# UK Government Service Graph — PoC

NB: This is a hand-crafted proof of concept for illustration and education purposes only. Not a approved plan from GDS. 

An interactive graph explorer and MCP server for UK government life events.

**[View the live graph →](https://maxwellriess.github.io/UK-Gov-Service-Graph-poc/)**

This is a proof-of-concept for a machine-readable service graph that maps the cross-departmental dependencies between UK government services. The core idea: government services don't exist in isolation — registering a death is a prerequisite for bereavement benefits, registering a birth unlocks child benefit — and making those relationships explicit and machine-readable enables AI agents to guide citizens through the right services in the right order.

---

## The graph explorer

The interactive explorer visualises 96 service nodes across 12 departments, connected by two edge types:

- **REQUIRES** (solid blue arrow) — strict ordering; must complete the source before the target
- **ENABLES** (dashed grey arrow) — the source makes the target accessible or relevant

**Controls:**
- Click a life event in the sidebar to trace all services reachable from that entry point
- Click a department to highlight its services and connections
- Click any node to open a detail panel with eligibility info, prerequisites, and GOV.UK links
- Toggle edge types on/off; switch between Force / Hierarchy / BFS layouts
- Search filters nodes by name or department

---

## The MCP server

The `src/graph-server.ts` file is an MCP server exposing the graph to AI agents via three tools:

| Tool | What it does |
|---|---|
| `list_life_events` | Returns the 13 supported life events as entry points |
| `plan_journey` | Computes a sequenced, phased service journey for one or more life events |
| `get_service` | Returns full eligibility detail for a specific service node |

Connect it to Claude Desktop by adding to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "uk-services-graph": {
      "command": "npx",
      "args": ["tsx", "/path/to/this/repo/src/graph-server.ts"]
    }
  }
}
```

Then ask Claude: *"My father just died. What do I need to do?"*

---

## Run locally

```bash
npm install

# Regenerate index.html from graph data
npm run build

# Run the MCP server (for Claude Desktop)
npm run mcp
```

---

## Repository structure

```
index.html          Static graph explorer (self-contained, GitHub Pages)
src/
  graph-data.ts     96 service nodes, typed edges, 13 life events
  graph-engine.ts   BFS + topological sort → phased journey planner
  graph-server.ts   MCP server (list_life_events, plan_journey, get_service)
scripts/
  build-index.ts    Generates index.html from graph data
```

---

## What this demonstrates

The graph models the **semantic layer** needed for AI agents to navigate government services:

- Service nodes carry structured eligibility data (criteria, key questions, evidence required)
- Typed edges encode cross-departmental ordering constraints
- Life events are named entry points that map citizen situations to service subgraphs
- Eligibility signals (`proactive`, `gated`, `universal`, `means_tested`) tell agents how to present each service

