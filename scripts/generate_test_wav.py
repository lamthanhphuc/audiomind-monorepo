import sys
import wave
import struct
import math

# Usage: python generate_test_wav.py out.wav seconds

def generate_sine(path, seconds=5, freq=440, framerate=16000):
    nframes = int(seconds * framerate)
    amplitude = 16000
    with wave.open(path, 'w') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(framerate)
        for i in range(nframes):
            t = i / framerate
            value = int(amplitude * math.sin(2 * math.pi * freq * t))
            data = struct.pack('<h', value)
            wf.writeframesraw(data)

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'test-audio.wav'
    secs = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    generate_sine(out, secs)
    print(f"Generated {out} ({secs}s)")
