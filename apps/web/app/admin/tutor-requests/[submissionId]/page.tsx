import { TutorRequestDetail } from "@/features/tutor/admin";
export default async function Page({
  params,
}: {
  params: Promise<{ submissionId: string }>;
}) {
  const { submissionId } = await params;
  return <TutorRequestDetail submissionId={submissionId} />;
}
