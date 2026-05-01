import asyncio
import json
import sys
from urllib.parse import quote

import websockets

if len(sys.argv) < 3:
    print("Usage: ws_listener.py <meeting_id> <token> [ws_base_url]")
    sys.exit(1)

meeting_id = sys.argv[1]
token = sys.argv[2]
ws_base_url = sys.argv[3] if len(sys.argv) >= 4 else "ws://localhost:8082"

uri = f"{ws_base_url.rstrip('/')}/ws/meetings/{meeting_id}"
if token:
    uri = f"{uri}?token={quote(token)}"

async def listen():
    print(f"Connecting to {uri}", flush=True)
    try:
        # Connect using the signed token in the query string for dev compatibility.
        async with websockets.connect(
            uri,
            additional_headers={"Authorization": f"Bearer {token}"},
        ) as ws:
            async for msg in ws:
                try:
                    data = json.loads(msg)
                except Exception:
                    print("NON-JSON MSG:", msg, flush=True)
                    continue
                t = data.get('type')
                dump = json.dumps(data, ensure_ascii=False)
                print(f"EVENT: {t} | {dump[:1000]}", flush=True)
                if t == 'keyword.hit':
                    print(f"KEYWORD: {data.get('term')} (confidence: {data.get('confidence')})", flush=True)
    except Exception as e:
        print("WS LISTENER ERROR:", e, flush=True)

if __name__ == '__main__':
    asyncio.run(listen())
