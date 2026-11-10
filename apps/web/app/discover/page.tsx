import { Suspense } from "react";
import { Discover } from "@/features/tutor/discovery";

export const metadata = { title: "Find tutors" };
export default function Page() {
  return (
    <Suspense fallback={<p>Loading discovery...</p>}>
      <Discover />
    </Suspense>
  );
}
