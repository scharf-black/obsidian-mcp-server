import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import fetch from "node-fetch";
import { randomUUID } from "crypto";

// ── Config ──────────────────────────────────────────────────────────────────
const OBSIDIAN_BASE_URL = process.env.OBSIDIAN_BASE_URL ?? "http://localhost:27123";
const OBSIDIAN_API_KEY  = process.env.OBSIDIAN_API_KEY  ?? "";
const PORT              = parseInt(process.env.PORT ?? "3000", 10);
const VERIFY_SSL        = process.env.OBSIDIAN_VERIFY_SSL !== "false";

if (!OBSIDIAN_API_KEY) {
  console.error("FATAL: OBSIDIAN_API_KEY is not set");
  process.exit(1);
}

// ── Obsidian API client ──────────────────────────────────────────────────────
async function obsidianRequest(
  method: string,
  path: string,
  body?: unknown,
  contentType?: string
): Promise<unknown> {
  const url = `${OBSIDIAN_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${OBSIDIAN_API_KEY}`,
    "Content-Type": contentType ?? "application/json",
  };

  let serializedBody: string | undefined;
  if (body !== undefined) {
    serializedBody = contentType === "text/markdown" ? (body as string) : JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: serializedBody,
    // @ts-ignore — node-fetch v3 agent option
    agent: VERIFY_SSL ? undefined : new (await import("https")).Agent({ rejectUnauthorized: false }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Obsidian API ${method} ${path} → ${res.status}: ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

// ── MCP Server ───────────────────────────────────────────────────────────────
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "obsidian-mcp-server", version: "1.0.0" });

  // List vault root
  server.registerTool(
    "obsidian_list_files_in_vault",
    {
      title: "List Files in Vault",
      description: "Lists all files and directories in the root of the Obsidian vault.",
      inputSchema: {},
    },
    async () => {
      const data = await obsidianRequest("GET", "/vault/");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // List files in directory
  server.registerTool(
    "obsidian_list_files_in_dir",
    {
      title: "List Files in Directory",
      description: "Lists files and directories within a specific vault folder.",
      inputSchema: { dirpath: z.string().describe("Path relative to vault root, e.g. 'Daily Notes'") },
    },
    async ({ dirpath }) => {
      const encoded = encodeURIComponent(dirpath).replace(/%2F/g, "/");
      const data = await obsidianRequest("GET", `/vault/${encoded}/`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Get file contents
  server.registerTool(
    "obsidian_get_file_contents",
    {
      title: "Get File Contents",
      description: "Returns the content of a single file in the vault.",
      inputSchema: { filepath: z.string().describe("Path relative to vault root, e.g. 'Daily Notes/2025-01-01.md'") },
    },
    async ({ filepath }) => {
      const encoded = encodeURIComponent(filepath).replace(/%2F/g, "/");
      const data = await obsidianRequest("GET", `/vault/${encoded}`);
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
    }
  );

  // Append content
  server.registerTool(
    "obsidian_append_content",
    {
      title: "Append Content",
      description: "Appends content to a new or existing file in the vault.",
      inputSchema: {
        filepath: z.string().describe("Path relative to vault root"),
        content:  z.string().describe("Content to append"),
      },
    },
    async ({ filepath, content }) => {
      const encoded = encodeURIComponent(filepath).replace(/%2F/g, "/");
      await obsidianRequest("POST", `/vault/${encoded}`, content, "text/markdown");
      return { content: [{ type: "text", text: `Appended to ${filepath}` }] };
    }
  );

  // Patch content (insert relative to heading)
  server.registerTool(
    "obsidian_patch_content",
    {
      title: "Patch Content",
      description: "Inserts content into a note relative to a heading or block reference.",
      inputSchema: {
        filepath:   z.string().describe("Path relative to vault root"),
        content:    z.string().describe("Content to insert"),
        heading:    z.string().optional().describe("Heading to insert after (optional)"),
        insertAfter: z.boolean().optional().describe("Insert after the heading (default true)"),
      },
    },
    async ({ filepath, content, heading }) => {
      const encoded = encodeURIComponent(filepath).replace(/%2F/g, "/");
      const headers: Record<string, string> = {};
      if (heading) headers["Heading"] = heading;
      const url = `${OBSIDIAN_BASE_URL}/vault/${encoded}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${OBSIDIAN_API_KEY}`,
          "Content-Type": "text/markdown",
          ...headers,
        },
        body: content,
        // @ts-ignore
        agent: VERIFY_SSL ? undefined : new (await import("https")).Agent({ rejectUnauthorized: false }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Obsidian API PATCH /vault/${encoded} → ${res.status}: ${text}`);
      }
      return { content: [{ type: "text", text: `Patched ${filepath}` }] };
    }
  );

  // Simple search
  server.registerTool(
    "obsidian_simple_search",
    {
      title: "Simple Search",
      description: "Searches for text across all files in the vault.",
      inputSchema: {
        query:           z.string().describe("Text to search for"),
        contextLength:   z.number().optional().describe("Characters of context around match (default 100)"),
      },
    },
    async ({ query, contextLength }) => {
      const params = new URLSearchParams({ query });
      if (contextLength) params.set("contextLength", String(contextLength));
      const data = await obsidianRequest("POST", `/search/simple/?${params}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Complex search (JsonLogic)
  server.registerTool(
    "obsidian_complex_search",
    {
      title: "Complex Search",
      description: "Searches using a JsonLogic query. Supports glob and regexp operators.",
      inputSchema: {
        query: z.record(z.unknown()).describe("JsonLogic query object, e.g. {glob: ['*.md', {var: 'path'}]}"),
      },
    },
    async ({ query }) => {
      const data = await obsidianRequest("POST", "/search/", query);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Delete file
  server.registerTool(
    "obsidian_delete_file",
    {
      title: "Delete File",
      description: "Deletes a file or directory from the vault.",
      inputSchema: { filepath: z.string().describe("Path relative to vault root") },
    },
    async ({ filepath }) => {
      const encoded = encodeURIComponent(filepath).replace(/%2F/g, "/");
      await obsidianRequest("DELETE", `/vault/${encoded}`);
      return { content: [{ type: "text", text: `Deleted ${filepath}` }] };
    }
  );

  // Get periodic note
  server.registerTool(
    "obsidian_get_periodic_note",
    {
      title: "Get Periodic Note",
      description: "Gets the current periodic note for a given period.",
      inputSchema: {
        period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
                  .describe("The period type"),
      },
    },
    async ({ period }) => {
      const data = await obsidianRequest("GET", `/periodic/${period}/`);
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
    }
  );

  // Get recent periodic notes
  server.registerTool(
    "obsidian_get_recent_periodic_notes",
    {
      title: "Get Recent Periodic Notes",
      description: "Returns the most recent periodic notes for a given period type.",
      inputSchema: {
        period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]),
        limit:  z.number().optional().describe("Max number to return (default 5)"),
      },
    },
    async ({ period, limit }) => {
      const params = limit ? `?limit=${limit}` : "";
      const data = await obsidianRequest("GET", `/periodic/${period}/${params}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Get recently modified files
  server.registerTool(
    "obsidian_get_recent_changes",
    {
      title: "Get Recent Changes",
      description: "Returns recently modified files in the vault.",
      inputSchema: {
        limit: z.number().optional().describe("Max files to return (default 10)"),
      },
    },
    async ({ limit }) => {
      const params = limit ? `?limit=${limit}` : "";
      const data = await obsidianRequest("GET", `/vault/${params}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Batch get file contents
  server.registerTool(
    "obsidian_batch_get_file_contents",
    {
      title: "Batch Get File Contents",
      description: "Returns contents of multiple files concatenated with headers.",
      inputSchema: {
        filepaths: z.array(z.string()).describe("Array of paths relative to vault root"),
      },
    },
    async ({ filepaths }) => {
      const results: string[] = [];
      for (const filepath of filepaths) {
        try {
          const encoded = encodeURIComponent(filepath).replace(/%2F/g, "/");
          const data = await obsidianRequest("GET", `/vault/${encoded}`);
          results.push(`\n\n---\n## ${filepath}\n\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);
        } catch (err) {
          results.push(`\n\n---\n## ${filepath}\n\nERROR: ${err}`);
        }
      }
      return { content: [{ type: "text", text: results.join("") }] };
    }
  );

  return server;
}

// ── Express + Streamable HTTP ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports.has(sessionId)) {
    transport = transports.get(sessionId)!;
  } else {
    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => { transports.set(id, transport); },
    });

    transport.onclose = () => transports.delete(newSessionId);

    const server = buildMcpServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.close();
    transports.delete(sessionId);
  }
  res.status(200).json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ status: "ok", vault: OBSIDIAN_BASE_URL }));

app.listen(PORT, () => {
  console.log(`obsidian-mcp-server listening on port ${PORT}`);
  console.log(`Obsidian vault: ${OBSIDIAN_BASE_URL}`);
});
