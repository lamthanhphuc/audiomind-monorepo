import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.1'],
    http_req_duration: ['p(95)<2000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

export default function () {
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health status is 200 or 204': (r) => r.status === 200 || r.status === 204,
  });

  sleep(1);
}
