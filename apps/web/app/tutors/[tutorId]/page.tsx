import { TutorProfile } from "@/features/tutor/discovery";

export const metadata = { title: "Tutor profile" };
export default async function Page({
  params,
}: {
  params: Promise<{ tutorId: string }>;
}) {
  const { tutorId } = await params;
  return <TutorProfile tutorId={tutorId} />;
}
