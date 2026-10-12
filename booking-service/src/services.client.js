const TUTOR_URL = process.env.TUTOR_URL || 'http://127.0.0.1:4001';
const WALLET_URL = process.env.WALLET_URL || 'http://127.0.0.1:4003';

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function getTutor(tutorId) {
  return request(`${TUTOR_URL}/tutors/${tutorId}`);
}

function chargeLessonPayment(payment) {
  return request(`${WALLET_URL}/internal/charges`, { method: 'POST', body: JSON.stringify(payment) });
}

function refundBooking(refund) {
  return request(`${WALLET_URL}/internal/refunds`, { method: 'POST', body: JSON.stringify(refund) });
}

module.exports = { getTutor, chargeLessonPayment, refundBooking };
