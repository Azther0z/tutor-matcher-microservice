export type Channels = { email: boolean; push: boolean };
export type PreferencesWrite = {
  bookingUpdates: Channels;
  lessonReminders: Channels;
  newMessages: Channels;
  walletPayments: Channels;
  productNews: Channels;
};
export type Preferences = PreferencesWrite & { revision: string };
export type PreferenceGroup = keyof PreferencesWrite;

export const GROUPS: Array<{ key: PreferenceGroup; label: string; hint: string }> = [
  { key: "bookingUpdates", label: "Booking updates", hint: "Confirmations, changes and cancellations." },
  { key: "lessonReminders", label: "Lesson reminders", hint: "Reminders before a lesson starts." },
  { key: "newMessages", label: "New messages", hint: "When someone writes to you." },
  { key: "walletPayments", label: "Wallet and payments", hint: "Top-ups, refunds, earnings and payouts." },
  { key: "productNews", label: "Product news", hint: "Occasional updates about Tutor Matcher." },
];

export type Receipt = {
  id: string;
  eventId: string;
  recipientUserId: string;
  channel: "EMAIL" | "PUSH";
  category: "BOOKING_UPDATES" | "LESSON_REMINDERS" | "NEW_MESSAGES" | "WALLET_PAYMENTS" | "PRODUCT_NEWS" | "SYSTEM";
  status: "PENDING" | "DELIVERED" | "SKIPPED" | "FAILED";
  demo: true;
  createdAt: string;
  deliveredAt: string | null;
};
