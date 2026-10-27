import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8080';
const TUTORS = 20;

export const options = {
  scenarios: {
    search: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

const json = { headers: { 'Content-Type': 'application/json' } };

export function setup() {
  const account = { email: 'loadtest@tutor.test', password: 'loadtest123', displayName: 'Load Test' };
  http.post(`${BASE_URL}/auth/register`, JSON.stringify(account), {
    ...json,
    responseCallback: http.expectedStatuses(201, 409),
  });
  const login = http.post(`${BASE_URL}/auth/login`, JSON.stringify(account), json);
  const token = login.json('token');
  const auth = { headers: { ...json.headers, Authorization: `Bearer ${token}` } };

  const existing = http.get(`${BASE_URL}/tutors?q=LoadTest`).json();
  for (let i = existing.length; i < TUTORS; i += 1) {
    http.post(`${BASE_URL}/tutors`, JSON.stringify({
      firstName: `Tutor${i}`,
      lastName: 'LoadTest',
      email: `loadtest-${i}@tutor.test`,
      bio: 'Seeded for the load test',
      status: 'PUBLISHED',
      subjects: [{ name: 'Mathematics', description: 'Algebra and calculus', hourlyRate: 300 + i * 10 }],
    }), auth);
  }
}

export default function () {
  const res = http.get(`${BASE_URL}/tutors?subject=Mathematics&maxRate=1000`);
  check(res, {
    'status 200': (r) => r.status === 200,
    'found tutors': (r) => Array.isArray(r.json()) && r.json().length >= TUTORS,
  });
}
