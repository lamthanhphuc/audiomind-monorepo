import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)<4000'],
    http_req_failed: ['rate<0.1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8082';

export default function () {
  const payload = JSON.stringify({
    meetingId: Math.floor(Math.random() * 100000),
    source: 'k6-load',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-trace-id': `${Date.now()}-${__VU}-${__ITER}`,
    },
  };

  const res = http.post(`${BASE_URL}/api/processing/process`, payload, params);

  check(res, {
    'status is 2xx or 4xx accepted': (r) => r.status >= 200 && r.status < 500,
  });

  sleep(1);
}
