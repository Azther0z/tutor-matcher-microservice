import { RequireCapability } from "@/features/wallet/common";
import { NotificationsPage } from "@/features/notification/notifications";

export const metadata = { title: "Notifications" };

export default function Page() {
  return <RequireCapability capability="STUDENT"><NotificationsPage /></RequireCapability>;
}
