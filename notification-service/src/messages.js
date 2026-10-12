const templates = {
  'user.registered': (data) => ({
    recipients: [data.userId],
    message: `Welcome to Tutor Matcher, ${data.email}`,
  }),
  'wallet.topped_up': (data) => ({
    recipients: [data.userId],
    message: `Top-up of ${data.amount} THB received. Balance: ${data.balance} THB`,
  }),
  'booking.confirmed': (data) => ({
    recipients: [data.studentId, `tutor:${data.tutorId}`],
    message: `Booking ${data.bookingId} confirmed: ${data.subjectName}, ${data.amount} THB, starts ${data.startsAt}`,
  }),
  'booking.cancelled': (data) => ({
    recipients: [data.studentId, `tutor:${data.tutorId}`],
    message: `Booking ${data.bookingId} cancelled. Refund: ${data.refundAmount} THB`,
  }),
};

function render(event) {
  const template = templates[event.type];
  if (!template) return null;
  return template(event.data || {});
}

module.exports = { render };
