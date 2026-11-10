import { RequireCapability } from "@/features/wallet/common";
import { PayoutsPage } from "@/features/wallet/payouts";

export const metadata = { title: "Payouts" };

export default function Page() {
  return <RequireCapability capability="TUTOR"><PayoutsPage /></RequireCapability>;
}
