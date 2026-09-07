"""
chess-ai-hub MCP Server for Cursor
===================================
Exposes the visual server's chess capabilities as MCP tools:
  - analyze_fen: Analyze a FEN position
  - get_opening: Look up opening name for a FEN
  - lichess_game_info: Fetch Lichess game state
  - lichess_play_move: Make a move on Lichess (requires token)
  - parse_lichess_url: Parse a Lichess board URL to FEN
  - chess_visual_status: Check if the visual server is alive

This is a thin wrapper over the FastAPI visual server on port 3003.

Run: python3 visual/mcp_server.py
"""

import sys
import os
import json
import asyncio
import httpx

# MCP SDK 2.x uses constructor callbacks
try:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp.types import Tool, TextContent
    HAS_MCP = True
except ImportError:
    HAS_MCP = False

VISUAL_BASE = os.environ.get("CHESS_AI_VISUAL_BASE", "http://localhost:3003")


async def call_visual(path: str, method: str = "GET", **kwargs) -> dict:
    """Call the visual server."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(method, f"{VISUAL_BASE}{path}", **kwargs)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as e:
        return {"error": str(e), "ok": False}
    except Exception as e:
        return {"error": str(e), "ok": False}


# Tool definitions
ANALYZE_FEN_TOOL = Tool(
    name="analyze_fen",
    description="Analyze a chess position (FEN) with Stockfish. Returns best move, win rate, top N candidate lines with principal variations.",
    inputSchema={
        "type": "object",
        "properties": {
            "fen": {"type": "string", "description": "FEN notation of the chess position"},
            "depth": {"type": "integer", "description": "Search depth (default 18)", "default": 18},
            "multipv": {"type": "integer", "description": "Number of candidate lines (default 3)", "default": 3},
        },
        "required": ["fen"],
    },
)

GET_OPENING_TOOL = Tool(
    name="get_opening",
    description="Look up the opening name (ECO code + name) for a chess position via Lichess opening database.",
    inputSchema={
        "type": "object",
        "properties": {"fen": {"type": "string", "description": "FEN notation"}},
        "required": ["fen"],
    },
)

LICHESS_GAME_TOOL = Tool(
    name="lichess_game_info",
    description="Fetch current state of a public Lichess game by ID. Returns PGN, opening name, variant, and analysis URL.",
    inputSchema={
        "type": "object",
        "properties": {"game_id": {"type": "string", "description": "Lichess game ID (8-char alphanumeric)"}},
        "required": ["game_id"],
    },
)

PARSE_LICHESS_URL_TOOL = Tool(
    name="parse_lichess_url",
    description="Parse a Lichess board or analysis URL to extract the FEN position.",
    inputSchema={
        "type": "object",
        "properties": {"url": {"type": "string", "description": "Lichess board URL"}},
        "required": ["url"],
    },
)

STATUS_TOOL = Tool(
    name="chess_visual_status",
    description="Check whether the chess-ai-hub visual server is running on port 3003.",
    inputSchema={"type": "object", "properties": {}},
)


async def list_tools_handler(ctx, params):
    return {
        "tools": [
            ANALYZE_FEN_TOOL.model_dump(by_alias=True),
            GET_OPENING_TOOL.model_dump(by_alias=True),
            LICHESS_GAME_TOOL.model_dump(by_alias=True),
            PARSE_LICHESS_URL_TOOL.model_dump(by_alias=True),
            STATUS_TOOL.model_dump(by_alias=True),
        ]
    }


async def call_tool_handler(ctx, params):
    name = params.name
    args = params.arguments or {}

    if name == "analyze_fen":
        result = await call_visual(
            "/board/analyze",
            "POST",
            json={
                "fen": args["fen"],
                "depth": args.get("depth", 18),
                "multipv": args.get("multipv", 3),
            },
        )
    elif name == "get_opening":
        fen = args["fen"].replace(" ", "_")
        result = await call_visual(f"/lichess/opening?fen={fen}")
    elif name == "lichess_game_info":
        result = await call_visual(f"/lichess/game/{args['game_id']}")
    elif name == "parse_lichess_url":
        result = await call_visual("/lichess/board-url", "POST", json={"url": args["url"]})
    elif name == "chess_visual_status":
        result = await call_visual("/status")
    else:
        result = {"error": f"Unknown tool: {name}"}

    return {
        "content": [
            TextContent(type="text", text=json.dumps(result, indent=2)).model_dump(by_alias=True)
        ]
    }


async def main():
    if not HAS_MCP:
        print("ERROR: mcp SDK not installed. Run: pip install mcp", file=sys.stderr)
        sys.exit(1)

    server = Server(
        "chess-ai-hub",
        on_list_tools=list_tools_handler,
        on_call_tool=call_tool_handler,
    )

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    asyncio.run(main())
