import { SubjectDetails } from "@/features/tutor/discovery";
export default async function Page({
  params,
}: {
  params: Promise<{ tutorId: string; subjectId: string }>;
}) {
  const { tutorId, subjectId } = await params;
  return <SubjectDetails tutorId={tutorId} subjectId={subjectId} />;
}
