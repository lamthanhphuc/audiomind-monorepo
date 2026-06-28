#!/usr/bin/env python3
"""Debug STT stream endpoint"""
import asyncio
from pathlib import Path

async def test():
    from fastapi.testclient import TestClient
    from app.main import app
    
    audio_path = Path("/app/storage/test_audio.wav")
    if not audio_path.exists():
        # Create a simple test audio file
        import numpy as np
        sample_rate = 16000
        duration = 1  # 1 second
        samples = np.zeros((sample_rate * duration,), dtype=np.int16)
        audio_bytes = samples.tobytes()
        audio_path.parent.mkdir(parents=True, exist_ok=True)
        audio_path.write_bytes(audio_bytes)
    
    client = TestClient(app)
    
    with open(audio_path, 'rb') as f:
        response = client.post(
            "/api/v1/stt/stream",
            data={
                "meeting_id": "1",
                "seq": "1",
                "language": "vi",
                "is_final": "false",
            },
            files={"audio_chunk": ("test.wav", f, "audio/wav")}
        )
    
    print(f"Status: {response.status_code}")
    print(f"Response: {response.text}")
    if response.status_code >= 400:
        print(f"Error: {response.json()}")

asyncio.run(test())
