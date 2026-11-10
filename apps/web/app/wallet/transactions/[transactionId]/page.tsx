import { RequireCapability } from "@/features/wallet/common";
import { TransactionDetailPage } from "@/features/wallet/transactions";

export const metadata = { title: "Transaction" };

export default function Page({ params }: { params: Promise<{ transactionId: string }> }) {
  return <RequireCapability capability="STUDENT"><TransactionDetailPage params={params} /></RequireCapability>;
}
