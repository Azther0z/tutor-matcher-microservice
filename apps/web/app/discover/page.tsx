import { Suspense } from "react";
import { Discover } from "@/features/tutor/discovery";
export default function Page() {
  return (
    <Suspense fallback={<p>Loading discovery...</p>}>
      <Discover />
    </Suspense>
  );
}
