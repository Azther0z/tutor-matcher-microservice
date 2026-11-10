import type { Metadata } from "next";
import { PrivacyCopy } from "@/components/legal-copy";

export const metadata: Metadata = { title: "Privacy notice" };

export default function PrivacyPage() {
  return <><header className="section-heading"><h1>Privacy notice</h1><p>What this course demonstration stores and why.</p></header><section className="panel legal-copy"><PrivacyCopy /></section></>;
}
