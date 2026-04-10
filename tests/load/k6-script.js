import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 50,
  duration: '5m',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500', 'avg<800'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://api.audiomind.example.com';

export default function () {
  const payload = JSON.stringify({
    email: `load.user.${__VU}.${__ITER}@example.com`,
    password: 'ChangeMe123!',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const loginRes = http.post(`${BASE_URL}/api/users/login`, payload, params);
  check(loginRes, {
    'login status is 200 or 401': (r) => r.status === 200 || r.status === 401,
  });

  const healthRes = http.get(`${BASE_URL}/api/users/health`);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
