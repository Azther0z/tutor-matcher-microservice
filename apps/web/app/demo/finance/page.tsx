import { RequireCapability } from "@/features/wallet/common";
import { DemoFinancePage } from "@/features/wallet/demo-controls";

export const metadata = { title: "Demo provider controls" };

export default function Page() {
  return <RequireCapability capability="ADMIN"><DemoFinancePage /></RequireCapability>;
}
