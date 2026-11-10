import { ModerationQueue } from "@/features/review/moderation";

export const metadata = { title: "Review flags" };
export default function Page() {
  return <ModerationQueue />;
}
