# obsidian-mcp-server

Self-hosted Obsidian MCP server using **Streamable HTTP transport**. Runs as a persistent Docker container and exposes your Obsidian vault to any MCP-compatible client — Claude.ai connectors, Claude Code, n8n, MCP gateways (MCPJungle, MCPX), and more.

## Why This Exists

Most Obsidian MCP implementations use **stdio transport** — they run as subprocesses spawned by a local client. That works for desktop use but breaks in server environments where you need a persistent, network-accessible MCP endpoint.

This server wraps the Obsidian [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin in a proper Streamable HTTP MCP server. Credentials are configured at container startup, not resolved per-call — so it works with any MCP gateway or client without user-context dependencies.

## Prerequisites

- **Obsidian** running with the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin enabled
- **Docker** + Docker Compose
- The Obsidian instance must be network-reachable from the Docker host

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/scharf-black/obsidian-mcp-server.git
cd obsidian-mcp-server

# 2. Configure
cp .env.example .env
# Edit .env — set OBSIDIAN_API_KEY and OBSIDIAN_BASE_URL

# 3. Build and run
docker compose up -d --build

# 4. Verify
curl http://localhost:3010/health
# → {"status":"ok","vault":"http://host.docker.internal:27123"}
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OBSIDIAN_API_KEY` | Yes | — | API key from the Obsidian Local REST API plugin settings |
| `OBSIDIAN_BASE_URL` | Yes | `http://localhost:27123` | URL of the Obsidian Local REST API |
| `OBSIDIAN_VERIFY_SSL` | No | `true` | Set `false` if using Obsidian's self-signed HTTPS cert |
| `PORT` | No | `3000` | Internal container port |

## Available Tools (12)

| Tool | Description |
|---|---|
| `obsidian_list_files_in_vault` | List all files in vault root |
| `obsidian_list_files_in_dir` | List files in a specific directory |
| `obsidian_get_file_contents` | Get content of a single file |
| `obsidian_append_content` | Append to a file (creates if missing) |
| `obsidian_patch_content` | Insert content relative to a heading |
| `obsidian_simple_search` | Full-text search across all notes |
| `obsidian_complex_search` | JsonLogic query search |
| `obsidian_delete_file` | Delete a file or directory |
| `obsidian_get_periodic_note` | Get current daily/weekly/monthly note |
| `obsidian_get_recent_periodic_notes` | Get recent periodic notes |
| `obsidian_get_recent_changes` | Get recently modified files |
| `obsidian_batch_get_file_contents` | Get multiple files in one call |

## Registering with an MCP Gateway

### MCPJungle (recommended)

```bash
docker exec mcpjungle /mcpjungle register \
  --name obsidian \
  --description "Obsidian vault" \
  --url "http://obsidian-mcp:3000/mcp"
```

### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "streamable-http",
      "url": "http://localhost:3010/mcp"
    }
  }
}
```

### n8n (via Code node)

```javascript
const init = await this.helpers.httpRequest({
  method: 'POST', url: 'http://obsidian-mcp:3000/mcp',
  headers: {'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
  body: {jsonrpc:'2.0',id:0,method:'initialize',
    params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'n8n',version:'1.0'}}},
  json: true, returnFullResponse: true
});
const sid = init.headers['mcp-session-id'];

const result = await this.helpers.httpRequest({
  method: 'POST', url: 'http://obsidian-mcp:3000/mcp',
  headers: {'Content-Type':'application/json','Accept':'application/json','Mcp-Session-Id': sid},
  body: {jsonrpc:'2.0',id:1,method:'tools/call',
    params:{name:'obsidian_simple_search',arguments:{query:'project plan'}}},
  json: true
});
```

## Architecture

```
Obsidian (desktop app)
    │  Local REST API plugin (port 27123)
    ▼
obsidian-mcp-server (this container, port 3000)
    │  Streamable HTTP MCP transport
    ├── MCP Gateway (MCPJungle, MCPX, etc.)
    ├── Claude.ai connectors (via OAuth proxy)
    ├── Claude Code / Claude Desktop
    ├── n8n workflows
    └── Any MCP-compatible client
```

## Development

```bash
npm install
npm run dev    # Runs with tsx (hot reload)
```

## License

MIT
