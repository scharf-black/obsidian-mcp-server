# obsidian-mcp-server

Self-hosted Obsidian MCP server using **Streamable HTTP transport**. Runs as a persistent Docker container and exposes your Obsidian vault to any MCP-compatible client — Claude.ai connectors, Claude Code, n8n, MCP gateways (MCPJungle, MCPX), and more.

## Why This Exists

Most Obsidian MCP implementations use **stdio transport** — they run as subprocesses spawned by a local client. That works for desktop use but breaks in server environments where you need a persistent, network-accessible MCP endpoint.

This server wraps the Obsidian [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin in a proper Streamable HTTP MCP server. Credentials are configured at container startup, not resolved per-call — so it works with any MCP gateway or client without user-context dependencies.

## Prerequisites

- **Obsidian** (desktop app) running on a machine reachable from the Docker host
- **Obsidian Local REST API plugin** installed and configured (see setup below)
- **Docker** + Docker Compose

## Setting Up the Obsidian Local REST API Plugin

The MCP server doesn't talk to Obsidian directly — it communicates through the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin, which exposes your vault over HTTP.

### Install the plugin

1. Open Obsidian → Settings → Community plugins → Browse
2. Search for **"Local REST API"**
3. Install and enable it

### Configure the plugin

1. Go to Settings → Local REST API
2. Note the **API key** — you'll need this for the `.env` file
3. Choose your port and protocol:
   - **HTTP (port 27123)** — simplest, no SSL issues. Use this if both Obsidian and Docker run on the same machine
   - **HTTPS (port 27124)** — encrypted, but uses a self-signed certificate. Set `OBSIDIAN_VERIFY_SSL=false` in your `.env`
4. **Important:** If Obsidian runs on a different machine than Docker, enable "Listen on all interfaces" in the plugin settings (default is localhost only)

### Verify the API is working

```bash
# Replace YOUR_API_KEY with the key from plugin settings
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:27123/vault/
```

You should see a JSON list of files in your vault root.

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
| `OBSIDIAN_BASE_URL` | Yes | `http://localhost:27123` | URL of the Obsidian Local REST API (use `http://host.docker.internal:27123` when running in Docker on the same machine as Obsidian) |
| `OBSIDIAN_VERIFY_SSL` | No | `true` | Set `false` if using Obsidian's self-signed HTTPS cert (port 27124) |
| `PORT` | No | `3000` | Internal container port |

## Available Tools (12)

### Vault Navigation

| Tool | Description | Use Case |
|---|---|---|
| `obsidian_list_files_in_vault` | Lists all files and directories at the vault root | Get an overview of your vault's top-level structure |
| `obsidian_list_files_in_dir` | Lists files within a specific folder | Browse into project folders, daily notes directories, etc. |
| `obsidian_get_recent_changes` | Returns recently modified files | Find what you've been working on, catch up after time away |

### Reading Notes

| Tool | Description | Use Case |
|---|---|---|
| `obsidian_get_file_contents` | Returns the full content of a single note | Read a specific note, review a document, extract information |
| `obsidian_batch_get_file_contents` | Returns multiple files in one call | Efficiently read a set of related notes (e.g., all task files, a project's docs) |
| `obsidian_get_periodic_note` | Gets the current daily, weekly, monthly, quarterly, or yearly note | Access today's daily note, this week's weekly review, etc. |
| `obsidian_get_recent_periodic_notes` | Gets recent periodic notes for a given period type | Review the last 5 daily notes, last 3 weekly summaries |

### Writing & Editing

| Tool | Description | Use Case |
|---|---|---|
| `obsidian_append_content` | Appends content to an existing file or creates a new one | Add entries to a daily note, append meeting notes, log tasks |
| `obsidian_patch_content` | Inserts content relative to a specific heading | Add items under a particular section without overwriting the rest |
| `obsidian_delete_file` | Deletes a file or directory from the vault | Clean up temporary notes, remove outdated files |

### Search

| Tool | Description | Use Case |
|---|---|---|
| `obsidian_simple_search` | Full-text search across all notes with configurable context | Find notes mentioning a topic, locate specific information |
| `obsidian_complex_search` | Search using JsonLogic queries with glob and regexp support | Advanced queries like "all markdown files in Projects/ modified this week" |

## Registering with an MCP Gateway

### MCPJungle (recommended)

```bash
docker exec mcpjungle /mcpjungle register \
  --name obsidian \
  --description "Obsidian vault — notes, daily notes, search" \
  --url "http://obsidian-mcp:3000/mcp"
```

No bearer token needed if both containers share a Docker network.

### Claude Code / Claude Desktop

Add to your MCP client config:

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
// Initialize session
const init = await this.helpers.httpRequest({
  method: 'POST', url: 'http://obsidian-mcp:3000/mcp',
  headers: {'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
  body: {jsonrpc:'2.0',id:0,method:'initialize',
    params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'n8n',version:'1.0'}}},
  json: true, returnFullResponse: true
});
const sid = init.headers['mcp-session-id'];

// Call a tool
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
    │
    │  Local REST API plugin
    │  (port 27123 HTTP / 27124 HTTPS)
    │
    ▼
obsidian-mcp-server (this container, port 3000)
    │
    │  Streamable HTTP MCP transport
    │  (session-based, supports POST/GET/DELETE)
    │
    ├── MCP Gateway (MCPJungle, MCPX, etc.)
    ├── Claude.ai connectors (via OAuth proxy)
    ├── Claude Code / Claude Desktop
    ├── n8n workflows
    └── Any MCP-compatible client
```

## Docker Notes

- `host.docker.internal` resolves to your Docker host — use this for `OBSIDIAN_BASE_URL` when Obsidian runs on the same machine
- If Obsidian runs on a different host, use that machine's IP directly and ensure "Listen on all interfaces" is enabled in the plugin
- Multi-stage Dockerfile keeps the runtime image small (~180MB)
- The container is stateless — all data lives in your Obsidian vault

## Development

```bash
npm install
npm run dev    # Runs with tsx (hot reload)
```

## License

MIT
