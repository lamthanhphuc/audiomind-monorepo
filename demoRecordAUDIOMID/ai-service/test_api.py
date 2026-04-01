"""
Test script for AI Service
"""

import requests
import pytest

BASE_URL = "http://localhost:8000"


def test_health():
    """Test health endpoint"""
    print("Testing health endpoint...")
    try:
        response = requests.get(f"{BASE_URL}/health", timeout=5)
    except requests.RequestException as exc:
        pytest.skip(f"AI service is not reachable at {BASE_URL}: {exc}")

    print(f"Status: {response.status_code}")
    print(f"Response: {response.json()}\n")
    assert response.status_code == 200


def process_meeting(audio_path: str):
    """Test process endpoint"""
    print(f"Testing process endpoint with audio: {audio_path}")

    payload = {"audio_path": audio_path}

    response = requests.post(f"{BASE_URL}/api/process", json=payload)

    print(f"Status: {response.status_code}")
    print(f"Response: {response.json()}\n")

    if response.status_code == 200:
        result = response.json()
        return result.get("meeting_id")

    return None


def get_transcript(meeting_id: int):
    """Test get transcript endpoint"""
    print(f"Testing get transcript for meeting {meeting_id}...")

    response = requests.get(f"{BASE_URL}/api/meeting/{meeting_id}/transcript")

    print(f"Status: {response.status_code}")

    if response.status_code == 200:
        result = response.json()
        print(f"Transcript segments: {len(result.get('transcripts', []))}")
        print(f"First segment: {result.get('transcripts', [{}])[0]}\n")
    else:
        print(f"Error: {response.text}\n")


def get_analysis(meeting_id: int):
    """Test get analysis endpoint"""
    print(f"Testing get analysis for meeting {meeting_id}...")

    response = requests.get(f"{BASE_URL}/api/meeting/{meeting_id}/analysis")

    print(f"Status: {response.status_code}")

    if response.status_code == 200:
        result = response.json()
        print(f"Summary: {result.get('summary', '')[:100]}...")
        print(f"Keywords: {result.get('keywords', [])}")
        print(f"Technical terms: {result.get('technical_terms', [])}")
        print(f"Action items: {len(result.get('action_items', []))}\n")
    else:
        print(f"Error: {response.text}\n")


if __name__ == "__main__":
    # Test health
    test_health()

    # Test processing (update with your actual audio path)
    # audio_path = "uploads/test_meeting.wav"
    # meeting_id = process_meeting(audio_path)

    # If you have an existing meeting_id, uncomment and use:
    # meeting_id = 1
    # get_transcript(meeting_id)
    # get_analysis(meeting_id)

    print("Tests completed!")
