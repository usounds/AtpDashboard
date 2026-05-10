# ATProto Dashboard

ATProtoのFirehoseに流れてくる3rd party collectionを表示できるDashboardです。

This is a dashboard that displays 3rd party collections streamed through the ATProto Firehose.

https://atpdashboard.usounds.work/

## MCP endpoint

ATProto Dashboard exposes a public MCP-style HTTP JSON-RPC endpoint for AI/tool clients.

- MCP JSON-RPC endpoint: `https://dashboardapi.usounds.work/api/mcp`
- Read-only HTTP helper endpoints: `https://dashboardapi.usounds.work/api/analytics/mcp/*`
- Data source: ClickHouse-backed analytics API
- Cache: read-through cache with a 10 minute TTL
- Rate limit: currently 60 requests/minute per client

The MCP endpoint supports standard JSON-RPC methods such as `initialize`, `tools/list`, and `tools/call`.

### Quick checks with curl

List available tools:

```bash
curl -s https://dashboardapi.usounds.work/api/mcp \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

Call a tool:

```bash
curl -s https://dashboardapi.usounds.work/api/mcp \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_daily_collections",
      "arguments": {
        "days": 30
      }
    }
  }'
```

The HTTP helper endpoints are useful for quick manual checks without JSON-RPC:

```bash
curl -s 'https://dashboardapi.usounds.work/api/analytics/mcp/new_collection_groups?days=7'
curl -s 'https://dashboardapi.usounds.work/api/analytics/mcp/collections_for_namespace?namespace_prefix=app.bsky'
curl -s 'https://dashboardapi.usounds.work/api/analytics/mcp/daily_users?days=30'
curl -s 'https://dashboardapi.usounds.work/api/analytics/mcp/daily_collections?days=30'
```

### Claude Desktop configuration

If your client supports remote HTTP MCP directly, use:

```text
https://dashboardapi.usounds.work/api/mcp
```

For Claude Desktop environments that expect a stdio MCP server, use an HTTP bridge such as `mcp-remote`:

```json
{
  "mcpServers": {
    "atpdashboard": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://dashboardapi.usounds.work/api/mcp"
      ]
    }
  }
}
```

### Codex configuration

For Codex environments that support MCP server entries, the same stdio bridge pattern can be used:

```toml
[mcp_servers.atpdashboard]
command = "npx"
args = ["-y", "mcp-remote", "https://dashboardapi.usounds.work/api/mcp"]
```

If your Codex environment supports remote HTTP MCP URLs directly, configure the server URL as:

```text
https://dashboardapi.usounds.work/api/mcp
```

## MCP tools

### `get_new_collection_groups`

Returns namespace-grouped ATProto collections/NSIDs first observed in a recent window or explicit date range.

Parameters:

- `days`: integer, 1 to 14, default `7`
- `start_date`: optional date string, accepted formats include `YYYY-MM-DD`, `YYYY/MM/DD`, and Japanese date strings such as `2026年5月7日`
- `end_date`: optional date string, same accepted formats as `start_date`

Use this for questions such as "new NSIDs in the last 7 days" or "NSIDs born on 2026-05-07". Date-specific questions should usually be interpreted as namespace groups unless the user explicitly asks for individual NSIDs.

### `get_collections_for_namespace`

Lists observed ATProto collections/NSIDs under a namespace prefix and, when possible, resolves Lexicon definitions for schema summaries.

Parameters:

- `namespace_prefix`: required string, for example `app.bsky` or `app.bsky.*`

This tool is for schema and NSID discovery. Do not use it to fetch or display real record JSON bodies.

### `get_daily_users`

Returns rolling 24 hour bucket time series for Daily Users.

Parameters:

- `days`: integer, 1 to 365, default `7`

Rows include `date`, `day_offset`, `active`, and `new`. Use `days=7` for This Week, `days=30` for This Month, and `days=365` for This Year.

### `get_daily_collections`

Returns rolling 24 hour bucket time series for Daily Collections.

Parameters:

- `days`: integer, 1 to 365, default `30`

Rows include `date`, `day_offset`, `active`, and `new`. Use `days=7` for This Week, `days=30` for This Month, and `days=365` for This Year.

### `get_latest_record_for_collection`

Finds the latest observed record for a collection/NSID by `created_at`.

Parameters:

- `collection`: required ATProto collection/NSID, for example `app.bsky.feed.like`

This tool returns guidance for checking the record in `pds.ls`. Do not fetch, paste, or display the full real record JSON body in chat.
