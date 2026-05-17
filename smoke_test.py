import urllib.request
import urllib.parse
import urllib.error
import json
import time
import uuid
import sys
import sys

sys.stdout.reconfigure(encoding='utf-8')

def make_request(url, data=None, headers=None):
    if headers is None:
        headers = {}
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        response = urllib.request.urlopen(req)
        return response.status, response.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        print(f"Error connecting to {url}: {e}")
        return 500, b""

# 1. Register and Login
import random
test_user = f"e2e_test_user_{random.randint(1000, 9999)}"
print("Registering user...")
status, body = make_request("http://localhost:8083/api/users/register", 
    data=json.dumps({"username": test_user, "password": "Test@123456", "email": f"{test_user}@example.com"}).encode('utf-8'),
    headers={"Content-Type": "application/json"})
print(f"Register status: {status}, body: {body.decode('utf-8')}")

print("Logging in...")
status, body = make_request("http://localhost:8083/api/users/login", 
    data=json.dumps({"username": test_user, "password": "Test@123456"}).encode('utf-8'),
    headers={"Content-Type": "application/json"})

if status != 200:
    print(f"Login failed: {status} {body.decode('utf-8')}")
    sys.exit(1)

token = json.loads(body)['accessToken']
print("Got token:", token[:10], "...")

# 2. Upload file
boundary = uuid.uuid4().hex
with open('test_audio.mp3', 'rb') as f:
    audio_data = f.read()

body = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="title"\r\n\r\n'
    f"Real IT Meeting\r\n"
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="test_audio.mp3"\r\n'
    f'Content-Type: audio/mpeg\r\n\r\n'
).encode('utf-8') + audio_data + f"\r\n--{boundary}--\r\n".encode('utf-8')

print("Uploading to meeting-api...")
status, body = make_request("http://localhost:8081/meetings/upload", data=body, headers={
    "Authorization": f"Bearer {token}",
    "Content-Type": f"multipart/form-data; boundary={boundary}"
})

if status != 200:
    print(f"Upload failed: {status} {body.decode('utf-8')}")
    sys.exit(1)

meeting_resp = json.loads(body)
meeting_id = meeting_resp['id']
audio_path = meeting_resp.get('audioPath')
print(f"Created meeting {meeting_id} with audio path: {audio_path}")

# 3. Start processing
print("Starting processing...")
status, body = make_request(f"http://localhost:8082/processing/start/{meeting_id}", data=b"", headers={
    "Authorization": f"Bearer {token}"
})

if status != 200:
    print(f"Start processing failed: {status} {body.decode('utf-8')}")
    sys.exit(1)

print("Processing started")

# 4. Poll
while True:
    try:
        status, body = make_request(f"http://localhost:8082/processing/status/{meeting_id}", headers={
            "Authorization": f"Bearer {token}"
        })
        if status != 200:
            print(f"Poll non-200: {status}")
            time.sleep(2)
            continue
        status_resp = json.loads(body)
        job_status = status_resp['status']
        print(f"Status: {job_status}")
        if job_status == 'FAILED':
            print(f"Error: {status_resp.get('error')}")
        if job_status in ['COMPLETED', 'FAILED']:
            break
    except Exception as e:
        print(f"Poll error: {e}")
    time.sleep(2)

# 5. Transcript and Analysis
print("Fetching transcript...")
status, body = make_request(f"http://localhost:8082/processing/transcript/{meeting_id}", headers={"Authorization": f"Bearer {token}"})
transcript = json.loads(body)
print("Transcript:", transcript)

print("Fetching analysis...")
status, body = make_request(f"http://localhost:8082/processing/{meeting_id}/analysis", headers={"Authorization": f"Bearer {token}"})
analysis = json.loads(body)
print("Analysis:", analysis)
