#!/usr/bin/env python3
"""Diagnose STT pipeline initialization"""
from app.main import pipeline, settings, _build_stt_session, stt_adapter

print("=== Configuration ===")
print(f"Deepgram API key configured: {bool(settings.deepgram_api_key)}")
print(f"Deepgram model: {settings.deepgram_model}")

print("\n=== Adapters ===")
print(f"Module-level stt_adapter: {stt_adapter}")
print(f"Module-level stt_adapter type: {type(stt_adapter).__name__ if stt_adapter else 'None'}")

print("\n=== Pipeline ===")
print(f"Pipeline: {pipeline}")
if pipeline:
    print(f"Pipeline.speech_recognizer: {pipeline.speech_recognizer}")
    print(f"Has speech_recognizer attr: {hasattr(pipeline, 'speech_recognizer')}")

print("\n=== Session Builder ===")
try:
    adapter = _build_stt_session("vi")
    print(f"Built adapter type: {type(adapter).__name__}")
    print(f"Built adapter: {adapter}")
except Exception as e:
    print(f"Error building adapter: {e}")
    import traceback
    traceback.print_exc()
