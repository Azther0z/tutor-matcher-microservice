import { RequireCapability } from "@/features/wallet/common";
import { PayoutsPage } from "@/features/wallet/payouts";

export default function Page() {
  return <RequireCapability capability="TUTOR"><PayoutsPage /></RequireCapability>;
}
