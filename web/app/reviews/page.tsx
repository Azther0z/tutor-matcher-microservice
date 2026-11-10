import { Suspense } from "react";
import { ReviewsFromQuery } from "@/features/review/reviews";
export default function Page() {
  return (
    <Suspense fallback={<p>Loading reviews...</p>}>
      <ReviewsFromQuery />
    </Suspense>
  );
}
