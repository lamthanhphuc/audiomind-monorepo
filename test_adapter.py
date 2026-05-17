#!/usr/bin/env python3
import asyncio
from app.config import get_settings
from app.main import _build_stt_session, pipeline

async def test():
    settings = get_settings()
    print(f"Deepgram API Key: [{settings.deepgram_api_key}]")
    print(f"Pipeline: {pipeline}")
    
    try:
        adapter = _build_stt_session("vi")
        print(f"Adapter created: {adapter}")
        print(f"Adapter type: {type(adapter).__name__}")
    except Exception as e:
        print(f"Error creating adapter: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test())
