import { ReviewWriter } from "@/features/review/reviews";

export const metadata = { title: "Write a review" };
export default async function Page({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;
  return <ReviewWriter bookingId={bookingId} />;
}
