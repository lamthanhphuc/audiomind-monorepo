#!/usr/bin/env python3
"""Test STT pipeline"""
import requests
import sys
from pathlib import Path

def test_stt_stream():
    """Test /api/v1/stt/stream endpoint"""
    audio_path = Path("D:/Bin/EXE101/Thu_muc_moi/tests/audio/it-overview.mp3")
    
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}")
        return False
    
    print(f"Testing STT stream with: {audio_path}")
    print(f"File size: {audio_path.stat().st_size} bytes")
    
    url = "http://localhost:8000/api/v1/stt/stream"
    
    with open(audio_path, 'rb') as f:
        audio_bytes = f.read()
    
    # Prepare multipart form
    files = {
        'audio_chunk': ('audio.mp3', audio_bytes, 'audio/mpeg'),
    }
    
    data = {
        'meeting_id': '1',
        'seq': '1',
        'language': 'vi',
        'is_final': 'false',
    }
    
    print(f"\nSending request to: {url}")
    print(f"Data: {data}")
    
    try:
        response = requests.post(url, files=files, data=data, timeout=30)
        print(f"Status: {response.status_code}")
        print(f"Response: {response.text}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"\nTranscript: {result.get('transcript', '')}")
            print(f"Is Final: {result.get('is_final', False)}")
            print(f"Confidence: {result.get('confidence', 0)}")
            return True
        else:
            print(f"Error: {response.status_code}")
            return False
    except Exception as e:
        print(f"Exception: {e}")
        return False

if __name__ == "__main__":
    success = test_stt_stream()
    sys.exit(0 if success else 1)
