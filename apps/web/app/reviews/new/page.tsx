import { Suspense } from "react";
import { ReviewWriterFromQuery } from "@/features/review/reviews";
export default function Page() {
  return (
    <Suspense fallback={<p>Loading booking...</p>}>
      <ReviewWriterFromQuery />
    </Suspense>
  );
}
