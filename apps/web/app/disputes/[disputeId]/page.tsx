import { RequireCapability } from "@/features/wallet/common";
import { DisputeDetailPage } from "@/features/wallet/disputes";

export default function Page({ params }: { params: Promise<{ disputeId: string }> }) {
  return <RequireCapability capability="STUDENT"><DisputeDetailPage params={params} /></RequireCapability>;
}
